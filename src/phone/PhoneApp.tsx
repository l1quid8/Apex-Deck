import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

import { ApprovalCard } from "../ApprovalCard";
import { Markdown } from "../Markdown";
import { QuestionForm } from "../QuestionForm";
import { applyQuestionEvent, formView, restoreQuestions, type ThreadAsks } from "../questions";
import { withAttachments } from "../attachments";
import { appendToolToken } from "../composerMenu";
import { chooseOutcome, pickerMatches, pickerRows, workInRows, type PickerRow } from "../destinations";
import { dotState } from "../hostFacts";
import type { HostConnection } from "../hostConnections";
import { workspaceFamily, workspaceHost } from "../hostSession";
import { openPhoneHost, type PhoneHost } from "../phoneBackend";
import { phoneShell } from "../phoneShell";
import {
  addMachine, approvalWhere, downLine, draftVisible, forkLine, loadMachines, machinesKey, newThreadGate,
  pressNewThread, refusalLine, removeMachine, saveMachines, threadCount, threadSend, threadTitleFromMessage,
  type DirectMachine, type LinkStatus, type LinkView, type MachineKind,
} from "../phoneRules";
import { ageWords, HOST_TINTS, homeShort, hostTints, noteActive, sidebarSections } from "../sidebarModel";
import { webSocketConnect } from "../daemon/webSocketLink";
import { loadRoomState } from "../roomRecovery";
import { folderCopyText, writeClipboard } from "../threadCopy";
import { historyHasAttachments, placeThread, MoveRefused } from "../threadMove";
import type { AppSession, FolderListing, Message, NextStep, Pane, RoomOptions, ToolServer, Workspace } from "../types";
import { addFolders } from "../workspaces";
import {
  ArrowLeft, ArrowUp, Check, ChevronLeft, ChevronRight, Command, Copy, Files, Folder, Globe, Laptop, Lock, MessageSquare,
  More, Paperclip, Plug, Plus, Settings, Terminal, X,
} from "./icons";

const NO_ASKS: ThreadAsks = { questions: [], offer: null };

const SESSION_KEY = "apex-deck.phone.session.v1";
const DRAFT_KEY = "apex-deck.phone.drafts.v1";
const NEW_THREAD: RoomOptions = { policy: "mention", max_bot_hops: 3 };

type Tab = "threads" | "agents" | "code" | "library" | "machines";
type Draft = { text: string; files: { name: string; bytes: Uint8Array }[] };
type Pending = { id: string; workspaceId: string };
type Ask = { paneId: string; workspaceId: string };
type SheetKind = "project" | "work" | "files" | "tools";
/** Long-press or ⋯ on a row, + at the top of Threads, or renaming a thread. */
type Menu = { kind: "thread"; id: string } | { kind: "project"; id: string } | { kind: "new" } | { kind: "rename"; id: string; text: string };
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

/** A bot's colour, the same on every screen for the same name. */
function botTint(name: string): string {
  let sum = 0;
  for (const char of name) sum = (sum * 31 + char.charCodeAt(0)) >>> 0;
  return HOST_TINTS[sum % HOST_TINTS.length];
}

/** Hold a row for half a second to open its menu. The click that ends the hold is swallowed. */
function useLongPress() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  return {
    held,
    bind: (fn: () => void) => ({
      onPointerDown: () => { held.current = false; clear(); timer.current = setTimeout(() => { held.current = true; fn(); }, 500); },
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
      onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); clear(); held.current = true; fn(); },
    }),
  };
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
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [query, setQuery] = useState("");
  const [tools, setTools] = useState<ToolServer[] | null>(null);
  const [browse, setBrowse] = useState<Browse | null>(null);
  const [room, setRoom] = useState<{ id: string; messages: Message[]; approvals: { id: string; request: string; action: import("../types").ProposedAction }[]; participants: { id: string; display_name: string }[]; asks: ThreadAsks; plan: boolean } | null>(null);
  const [approvalStays, setApprovalStays] = useState<Record<string, boolean>>({});
  const [agents, setAgents] = useState<string[]>([]);
  const [confirmUnpair, setConfirmUnpair] = useState<string | null>(null);
  /** Approval cards open on each machine, by thread id, from that machine's events. */
  const [waiting, setWaiting] = useState<Record<string, string[]>>({});
  /** Newest message seen per thread on this phone, so Recents moves without a save to the Mac per message. */
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  /** Files still being read into a draft; Send waits for them. */
  const [reading, setReading] = useState(0);
  const readingRef = useRef(0);
  /** A sent draft's id → the thread it became, so a file that finishes reading late follows it. */
  const movedRef = useRef<Record<string, string>>({});
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

  // Every machine reports every thread's events, so the list can show activity and waiting approvals.
  useEffect(() => {
    let live = true;
    const stops: (() => void)[] = [];
    hosts.forEach((host) => {
      host.backend.onRoomEvent((id, event) => {
        if (event.type === "message_added") setSeen((all) => ({ ...all, [id]: Date.now() }));
        if (event.type === "approval_requested") setWaiting((all) => ({ ...all, [id]: [...(all[id] ?? []).filter((request) => request !== event.request), event.request] }));
        if (event.type === "approval_resolved") setWaiting((all) => ({ ...all, [id]: (all[id] ?? []).filter((request) => request !== event.request) }));
      }).then((stop) => { if (live) stops.push(stop); else stop(); }).catch(() => {});
    });
    return () => { live = false; stops.forEach((stop) => stop()); };
  }, [hosts]);

  const links: LinkView[] = hosts.map((host) => {
    const status = host.connection.get().status;
    return {
      id: host.machine.id, name: host.machine.name, kind: host.machine.kind, status: toLink(status),
      ...(status.kind === "failed" ? { problem: refusalLine(host.machine.name, status.reason) } : {}),
    };
  });
  const mac = links.find((link) => link.kind === "mac");
  const macHost = hosts.find((host) => host.machine.kind === "mac") ?? null;
  const macOnline = mac?.status === "online";
  const linkOf = (id: string) => links.find((link) => link.id === id) ?? null;
  const downWords = (id: string, name: string) => { const link = linkOf(id); return link ? downLine(link) : `Connecting to ${name}`; };

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
  const savedPanes = session?.panes;
  const panes = useMemo(() => (savedPanes ?? []).map((pane) => (seen[pane.id] ?? 0) > (pane.activeAt ?? 0) ? { ...pane, activeAt: seen[pane.id] } : pane), [savedPanes, seen]);
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
    if (!macHost) throw new Error(mac ? downLine(mac) : "Pair this phone with your Mac before saving a thread.");
    const fresh = await macHost.backend.sessionLoad();
    if (!fresh) throw new Error("The Mac has no saved threads.");
    const next = change(fresh);
    await macHost.backend.sessionSave(next);
    setSession(next);
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch { /* saved on the Mac */ }
    return next;
  }

  /** Change one saved thread on the Mac. */
  function patchPane(id: string, change: (pane: Pane) => Pane) {
    saveSession((current) => ({ ...current, panes: current.panes.map((item) => item.id === id ? change(item) : item) })).catch((error) => setNotice(words(error)));
  }

  function openThread(id: string) {
    setOpenId(id);
    setTab("threads");
    setSheet(null);
    setMenu(null);
    setAsk(null);
    const pane = panes.find((item) => item.id === id);
    if (pane?.unread) patchPane(id, (item) => ({ ...item, unread: undefined }));
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
    setMenu(null);
    setNotice("");
  }

  useEffect(() => {
    if (!openPane || !openWorkspace) { if (!viewingPending) setRoom(null); return; }
    const host = phoneHost(workspaceHost(openWorkspace));
    // Offline keeps what is already on screen under the banner; it reloads when the machine is back.
    if (!host || toLink(host.connection.get().status) !== "online") { setRoom((current) => current?.id === openPane.id ? current : null); return; }
    let live = true;
    let stop = () => {};
    loadRoomState(host.backend, openPane.id, [], NEW_THREAD, openWorkspace.path).then((state) => {
      if (!live) return;
      setWaiting((all) => ({ ...all, [openPane.id]: state.approvals.map((card) => card.request) }));
      setRoom({
        id: openPane.id,
        messages: state.snapshot.transcript,
        approvals: state.approvals,
        participants: state.snapshot.participants.map((participant) => ({ id: participant.id, display_name: participant.display_name })),
        asks: restoreQuestions({}, openPane.id, state, Date.now())[openPane.id] ?? NO_ASKS,
        plan: Boolean(state.plan ?? state.snapshot.plan),
      });
    }).catch((error) => { if (live) setNotice(words(error)); });
    host.backend.onRoomEvent((id, event) => {
      if (!live || id !== openPane.id) return;
      if (event.type === "message_added") setRoom((current) => current && current.id === id && !current.messages.some((message) => message.seq === event.message.seq) ? { ...current, messages: [...current.messages, event.message] } : current);
      if (event.type === "approval_requested") setRoom((current) => current && current.id === id ? { ...current, approvals: [...current.approvals.filter((card) => card.request !== event.request), { id: event.id, request: event.request, action: event.action }] } : current);
      if (event.type === "approval_resolved") setRoom((current) => current && current.id === id ? { ...current, approvals: current.approvals.filter((card) => card.request !== event.request) } : current);
      if (event.type === "plan_changed") setRoom((current) => current && current.id === id ? { ...current, plan: event.on } : current);
      setRoom((current) => {
        if (!current || current.id !== id) return current;
        const asks = applyQuestionEvent({ [id]: current.asks }, id, event, Date.now())[id] ?? NO_ASKS;
        return asks === current.asks ? current : { ...current, asks };
      });
    }).then((unlisten) => { if (live) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { live = false; stop(); };
    // Reloading follows the open thread and that machine's connection, not every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPane?.id, openWorkspace?.id, openLink?.status]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [room?.messages.length, room?.approvals.length, openId]);

  async function send() {
    const id = openId;
    if (!id || !openWorkspace || !openLink || sendingRef.current) return;
    if (readingRef.current > 0) { setNotice("Wait for the file to finish attaching."); return; }
    const draft = draftFor(id);
    const gate = threadSend(links, openLink.id, draft.text, draft.files.length);
    if (!gate.enabled) { if (gate.reason) setNotice(gate.reason); return; }
    const host = phoneHost(openLink.id);
    if (!host) return;
    // One send at a time: a second tap must not post twice or start a second thread.
    sendingRef.current = true;
    setSending(true);
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
        movedRef.current[pending.id] = made.id;
        setDrafts((all) => { const next = { ...all, [made.id]: all[pending.id] ?? draft }; delete next[pending.id]; return next; });
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
      // Clear only what was sent; anything typed or attached while it was sending stays.
      setDrafts((all) => {
        const now = all[sentPane.id] ?? emptyDraft();
        return { ...all, [sentPane.id]: { text: now.text === draft.text ? "" : now.text, files: now.files.filter((file) => !draft.files.includes(file)) } };
      });
      setNotice("");
      // One save for the title and Recents, so the two can't overwrite each other.
      const title = transcriptLength === 0 || sentPane.title === "New thread" ? threadTitleFromMessage(draft.text) : "New thread";
      await saveSession((current) => ({
        ...current,
        panes: noteActive(current.panes, sentPane.id, Date.now()).map((item) => item.id === sentPane.id && title !== "New thread" ? { ...item, title } : item),
      })).catch(() => {});
    } catch (error) {
      setNotice(words(error));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  /** Answer the question on the form, or skip it with `null`. */
  async function answer(request: string, answers: string[][] | null) {
    if (!openPane || !openLink) return;
    const host = phoneHost(openLink.id);
    if (!host || openLink.status !== "online") { setNotice(downLine(openLink)); return; }
    try { await host.backend.roomAnswer(openPane.id, request, answers); }
    catch (error) { setNotice(words(error)); }
  }

  /** Send a next step to the bot that suggested it. */
  async function sendStep(step: NextStep, by: string) {
    if (!openPane || !openLink) return;
    const host = phoneHost(openLink.id);
    if (!host || openLink.status !== "online") return;
    setRoom((current) => current ? { ...current, asks: { ...current.asks, offer: null } } : current);
    try { await host.backend.roomPostTo(openPane.id, step.prompt, [by], false); }
    catch (error) { setNotice(words(error)); }
  }

  async function stopPlanning() {
    if (!openPane || !openLink) return;
    try { await phoneHost(openLink.id)?.backend.roomSetPlan(openPane.id, false); }
    catch (error) { setNotice(words(error)); }
  }

  /** Rejects when the answer did not reach the machine, so the card stays open to try again. */
  async function decide(request: string, approve: boolean, always: boolean) {
    if (!openPane || !openLink) throw new Error("This thread is no longer open.");
    const host = phoneHost(openLink.id);
    if (!host || openLink.status !== "online") throw new Error(downLine(openLink));
    await host.backend.roomDecide(openPane.id, request, approve, always);
    const id = openPane.id;
    setWaiting((all) => ({ ...all, [id]: (all[id] ?? []).filter((item) => item !== request) }));
    setRoom((current) => current ? { ...current, approvals: current.approvals.filter((card) => card.request !== request) } : current);
  }

  function choose(pane: Pane, target: Workspace) {
    const targetLink = hostOf(target);
    if (!targetLink || targetLink.status !== "online") {
      setNotice(targetLink ? downLine(targetLink) : "That machine isn't paired with this phone.");
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
    if (!mac || mac.status !== "online") { setNotice(mac ? downLine(mac) : "Pair this phone with your Mac before saving a thread."); return; }
    if (toLink(from.connection.get().status) !== "online" || toLink(to.connection.get().status) !== "online") {
      const down = toLink(to.connection.get().status) !== "online" ? to.machine : from.machine;
      setNotice(downWords(down.id, down.name));
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
    if (!mac || mac.status !== "online") { setNotice(mac ? downLine(mac) : "Pair this phone with your Mac before saving a thread."); return; }
    if (toLink(from.connection.get().status) !== "online") { setNotice(downWords(from.machine.id, from.machine.name)); return; }
    if (toLink(to.connection.get().status) !== "online") { setNotice(downWords(to.machine.id, to.machine.name)); return; }
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
    if (toLink(host.connection.get().status) !== "online") { setNotice(downWords(hostId, host.machine.name)); return; }
    const macHasCopy = project ? workspaces.some((workspace) => !workspace.hidden && workspace.path && workspaceHost(workspace) === "local" && workspaceFamily(workspace) === workspaceFamily(project)) : false;
    setBrowse({ hostId, path: null, listing: null, error: "", projectName: project?.name ?? null, family: project ? workspaceFamily(project) : undefined, macCopy: macHasCopy && hostId !== "local", paneId });
    try {
      const listing = await host.backend.listFolder(null);
      setBrowse((current) => current && current.hostId === hostId ? { ...current, listing, path: listing.path } : current);
    } catch (error) {
      setBrowse((current) => current ? { ...current, error: words(error) } : current);
    }
  }

  function copyPath(path: string) {
    const text = folderCopyText(path);
    if (!text) { setNotice("This project has no folder."); return; }
    void writeClipboard(text, navigator.clipboard).then((ok) => setNotice(ok ? `Copied ${text}` : "The phone couldn't copy that path."));
  }

  const draft = openId ? draftFor(openId) : emptyDraft();
  const sendGate = openLink ? threadSend(links, openLink.id, draft.text, draft.files.length) : { enabled: false, reason: "This thread's machine isn't paired with this phone." };
  const tints = hostTints(machines.filter((machine) => machine.kind === "server").map((machine) => machine.id));
  const machineIcon = (hostId: string, size = 16) => hostId === "local"
    ? <span className="ph-host-icon" title={linkOf(hostId)?.name}><Laptop size={size} /></span>
    : <span className="ph-host-icon" style={{ color: tints.get(hostId) ?? "var(--brand-cyan)" }} title={linkOf(hostId)?.name}><Globe size={size} /></span>;
  const started = Boolean(openPane && ((room && room.id === openPane.id ? room.messages.length : 0) > (openPane.fork?.at ?? 0) || openPane.activeAt));
  const inChat = tab === "threads" && openId !== null && (openPane !== null || viewingPending) && openWorkspace !== null && openLink !== null;
  const covered = sheet !== null || menu !== null || ask !== null || browse !== null;
  const menuPane = menu && (menu.kind === "thread" || menu.kind === "rename") ? panes.find((pane) => pane.id === menu.id) ?? null : null;
  const menuProject = menu?.kind === "project" ? workspaces.find((workspace) => workspace.id === menu.id) ?? null : null;
  const askTarget = ask ? workspaces.find((workspace) => workspace.id === ask.workspaceId) ?? null : null;

  return (
    <div className="ph-app" data-rev={tick}>
      <div className="phone-frame">
        {!inChat && (
          <header className="ph-head" inert={covered}>
            {tab === "machines"
              ? <button type="button" className="ph-back" onClick={() => { setOpenId(null); setSheet(null); setTab("threads"); }}><ArrowLeft size={20} />Threads</button>
              : <h1 className="ph-large"><img className="ph-mark" src="/branding/mark.svg" alt="" width="26" height="26" />{tab[0].toUpperCase() + tab.slice(1)}</h1>}
            <span className="ph-head-actions">
              {tab === "threads" && <button type="button" className="ph-icon" aria-label="New thread" onClick={() => { setQuery(""); setMenu({ kind: "new" }); }}><Plus size={22} /></button>}
              {tab !== "machines" && <button type="button" className="ph-icon" aria-label="Settings and Machines" onClick={() => { setTab("machines"); setOpenId(null); }}><Settings size={20} /></button>}
            </span>
          </header>
        )}
        {inChat && openWorkspace && openLink ? (
          <ThreadView
            title={openPane?.title ?? "New thread"}
            draftThread={viewingPending}
            project={openWorkspace.name}
            machine={openLink.name}
            path={openWorkspace.path}
            kind={openLink.kind}
            link={openLink}
            hostIcon={machineIcon(openLink.id, 15)}
            started={started}
            messages={room && openPane && room.id === openPane.id ? room.messages : []}
            approvals={room && openPane && room.id === openPane.id ? room.approvals : []}
            participants={room && openPane && room.id === openPane.id ? room.participants : []}
            draft={draft}
            gate={sendGate}
            sending={sending}
            attaching={reading > 0}
            fork={openPane?.fork}
            approvalStays={openPane ? Boolean(approvalStays[openPane.id]) : false}
            other={links.find((link) => link.kind === "server" && link.status === "online" && link.id !== openLink.id) ?? null}
            endRef={endRef}
            covered={covered}
            onBack={() => { setOpenId(null); setSheet(null); }}
            onMenu={() => openPane && setMenu({ kind: "thread", id: openPane.id })}
            onDraft={(text) => openId && setDraft(openId, { ...draft, text })}
            onRemoveFile={(name) => openId && setDraft(openId, { ...draft, files: draft.files.filter((file) => file.name !== name) })}
            onSend={() => { void send(); }}
            onDecide={decide}
            form={<QuestionForm phone view={formView(room?.asks)} nameOf={(pid) => room?.participants.find((p) => p.id === pid)?.display_name ?? pid}
              highlighted={-1} collapsed={false} notice={null} onHighlight={() => {}} onExpand={() => {}}
              onAnswer={(request, answers) => { void answer(request, answers); }} onStep={(step, by) => { void sendStep(step, by); }}
              onDismiss={() => setRoom((current) => current ? { ...current, asks: { ...current.asks, offer: null } } : current)} />}
            plan={room?.plan ?? false}
            onStopPlanning={() => { void stopPlanning(); }}
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
              if (next === "tools") {
                setTools(null);
                const host = phoneHost(openLink.id);
                if (!openPane || !host || openLink.status !== "online") { setTools([]); return; }
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
            folded={folded}
            pending={pending}
            draft={pending ? draftFor(pending.id) : emptyDraft()}
            waiting={waiting}
            covered={covered}
            machineIcon={machineIcon}
            onToggle={(id) => setFolded((all) => ({ ...all, [id]: !(all[id] ?? Boolean(workspaces.find((workspace) => workspace.id === id)?.collapsed)) }))}
            onOpen={openThread}
            onNew={startIn}
            onThreadMenu={(id) => setMenu({ kind: "thread", id })}
            onProjectMenu={(id) => setMenu({ kind: "project", id })}
            onMachines={() => setTab("machines")}
          />
        ) : tab === "machines" ? (
          <Machines
            machines={machines}
            links={links}
            covered={covered}
            machineIcon={machineIcon}
            missing={[...new Set(workspaces.map((workspace) => workspaceHost(workspace)))].filter((id) => !machines.some((machine) => machine.id === id))}
            confirm={confirmUnpair}
            onAdd={(machine) => { setMachines((list) => addMachine(list, machine)); setNotice(`Pairing ${machine.name.trim()}…`); }}
            onUnpair={(id) => { setMachines((list) => removeMachine(list, id)); setConfirmUnpair(null); }}
            onConfirm={setConfirmUnpair}
            onRetry={(id) => phoneHost(id)?.connection.retryNow()}
            onError={setNotice}
          />
        ) : (
          <SideTab tab={tab} link={openLink ?? mac ?? null} agents={agents} covered={covered} onShow={() => {
            const host = openLink ? phoneHost(openLink.id) : macHost;
            if (!host || (openLink ?? mac)?.status !== "online") { setAgents([]); return; }
            host.backend.detectAgents().then((found) => setAgents(found.filter((agent) => agent.found).map((agent) => agent.label))).catch(() => setAgents([]));
          }} />
        )}
        {!inChat && <nav className="ph-tabs" aria-label="Sections" inert={covered}>
          {([[Command, "Agents", "agents"], [Terminal, "Code", "code"], [MessageSquare, "Threads", "threads"], [Folder, "Library", "library"]] as const).map(([Icon, label, item]) => (
            <button key={item} type="button" className={tab === item || (item === "threads" && tab === "machines") ? "on" : ""} aria-current={tab === item ? "page" : undefined} onClick={() => { setTab(item); if (item === "threads") setOpenId(null); }}>
              <Icon size={21} />{label}
            </button>
          ))}
        </nav>}
        {notice && (
          <div className="ph-toast" role="status">
            <span>{notice}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setNotice("")}><X size={16} /></button>
          </div>
        )}
        {ask && openPane && askTarget && (
          <Sheet title="Work on another machine?" onClose={() => setAsk(null)}>
            <p className="ph-sheet-text">“{openPane.title}” has started on {openLink?.name ?? "this machine"}, and a started thread stays on its machine. Open {askTarget.name} on {linkOf(workspaceHost(askTarget))?.name ?? "that machine"} as:</p>
            <button type="button" className="primary ph-wide" onClick={() => { setAsk(null); startIn(askTarget); }}>New thread</button>
            <button type="button" className="ph-wide" onClick={() => { void forkTo(openPane, askTarget); }}>Fork this thread<small>Copies the history. Nothing runs until you send.</small></button>
            <button type="button" className="ph-plain ph-wide" onClick={() => setAsk(null)}>Cancel</button>
          </Sheet>
        )}
        {sheet && openWorkspace && openLink && (
          <Sheet title={sheet === "project" ? "Project" : sheet === "work" ? "Work in" : sheet === "files" ? "Files" : "Tools"} onClose={() => setSheet(null)}>
            {sheet === "project" && <ProjectSheet rows={pickerRows(workspaces, panes, openWorkspace.id, (id) => linkOf(id)?.status !== "online")} links={links} query={query} machineIcon={machineIcon} onQuery={setQuery} onPick={pickWhere} />}
            {sheet === "work" && (
              <WorkSheet
                rows={workInRows(workspaces, machines.map((machine) => machine.id), openWorkspace, (id) => linkOf(id)?.status !== "online")}
                links={links}
                workspaces={workspaces}
                project={openWorkspace.name}
                mac={mac ?? null}
                stays={started ? openLink.name : null}
                machineIcon={machineIcon}
                onPick={pickWhere}
                onBrowse={(hostId) => { void openBrowse(hostId, openWorkspace, openPane?.id ?? null); setSheet(null); }}
                onNone={() => setNotice(mac && mac.status !== "online" ? downLine(mac) : "Working outside a project isn't in this phone build yet.")}
              />
            )}
            {sheet === "files" && <>
              <p className="ph-sheet-text">A file you attach is copied to {openLink.name} with the message. Nothing is copied until you send.</p>
              {draft.files.map((file) => <div key={file.name} className="ph-srow"><span className="ph-srow-icon"><Check size={18} /></span><span className="ph-grow"><strong>{file.name}</strong><small>Attached · sends with your next message</small></span></div>)}
              <label className="ph-srow ph-tap">
                <span className="ph-srow-icon"><Paperclip size={18} /></span>
                <span className="ph-grow"><strong>Attach a file…</strong><small>Photos, camera or Files</small></span>
                <input type="file" multiple hidden onChange={async (event) => {
                  // Copy the list first: clearing the input empties its live FileList.
                  const list = [...(event.target.files ?? [])];
                  event.target.value = "";
                  const id = openId;
                  if (list.length === 0 || !id) return;
                  readingRef.current += 1;
                  setReading(readingRef.current);
                  try {
                    const added = await Promise.all(list.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
                    // If the draft was sent meanwhile, the file goes to the thread it became.
                    const target = movedRef.current[id] ?? id;
                    setDrafts((all) => { const now = all[target] ?? emptyDraft(); return { ...all, [target]: { ...now, files: [...now.files, ...added] } }; });
                  } catch (error) {
                    setNotice(words(error));
                  } finally {
                    readingRef.current -= 1;
                    setReading(readingRef.current);
                  }
                }} />
              </label>
              <button type="button" className="ph-srow" onClick={() => copyPath(openWorkspace.path)}>
                <span className="ph-srow-icon"><Copy size={18} /></span>
                <span className="ph-grow"><strong>Copy folder path</strong><small>{openWorkspace.path || "No folder"}</small></span>
              </button>
            </>}
            {sheet === "tools" && (tools === null
              ? <p className="ph-sheet-text">Looking for tools on {openLink.name}…</p>
              : tools.length === 0
                ? <p className="ph-sheet-text">{openLink.status !== "online" ? downLine(openLink) : !openPane ? "Tools show once the thread has started." : `No tools on ${openLink.name} for this thread.`}</p>
                : tools.map((tool) => (
                  <button key={tool.token} type="button" className="ph-srow" onClick={() => { if (openId) setDraft(openId, { ...draft, text: appendToolToken(draft.text, tool.token) }); setSheet(null); }}>
                    <span className="ph-srow-icon"><Plug size={18} /></span>
                    <span className="ph-grow"><strong>{tool.label}</strong><small>!{tool.token}</small></span>
                  </button>
                )))}
          </Sheet>
        )}
        {menu?.kind === "new" && (
          <Sheet title="New thread in…" onClose={() => setMenu(null)}>
            <ProjectSheet rows={pickerRows(workspaces, panes, "", (id) => linkOf(id)?.status !== "online")} links={links} query={query} machineIcon={machineIcon} onQuery={setQuery} onPick={startIn} />
          </Sheet>
        )}
        {menu?.kind === "thread" && menuPane && (() => {
          const workspace = workspaces.find((item) => item.id === menuPane.workspaceId) ?? null;
          const link = workspace ? hostOf(workspace) : null;
          return (
            <Sheet title={menuPane.title} onClose={() => setMenu(null)}>
              <div className="ph-card">
                <p><strong>{workspace?.name ?? "No project"}</strong>{link ? ` · ${link.name}` : ""}</p>
                {workspace?.path && <p className="ph-path">{workspace.path}</p>}
                <p className="ph-meta">{link && link.status !== "online" ? `${downLine(link)} · ` : ""}{menuPane.activeAt ? `Active ${ageWords(Date.now() - menuPane.activeAt)} ago` : "Not started"}</p>
              </div>
              <MenuRow label={menuPane.pinned ? "Unpin" : "Pin"} onClick={() => { patchPane(menuPane.id, (item) => ({ ...item, pinned: item.pinned ? undefined : true })); setMenu(null); }} />
              <MenuRow label="Rename…" onClick={() => setMenu({ kind: "rename", id: menuPane.id, text: menuPane.title })} />
              {!menuPane.unread && <MenuRow label="Mark as unread" onClick={() => { patchPane(menuPane.id, (item) => ({ ...item, unread: true })); setMenu(null); if (openId === menuPane.id) setOpenId(null); }} />}
              {workspace?.path && <MenuRow label="Copy folder path" detail={folderCopyText(workspace.path)} onClick={() => { copyPath(workspace.path); setMenu(null); }} />}
              <MenuRow label="Archive" danger onClick={() => { patchPane(menuPane.id, (item) => ({ ...item, archived: true, pinned: undefined })); setMenu(null); if (openId === menuPane.id) setOpenId(null); }} />
            </Sheet>
          );
        })()}
        {menu?.kind === "rename" && menuPane && (
          <Sheet title="Rename thread" onClose={() => setMenu(null)}>
            <form onSubmit={(event) => { event.preventDefault(); const title = menu.text.trim(); if (!title) return; patchPane(menu.id, (item) => ({ ...item, title })); setMenu(null); }}>
              <label className="ph-label">Thread title<input value={menu.text} autoFocus onChange={(event) => setMenu({ ...menu, text: event.target.value })} /></label>
              <button type="submit" className="primary ph-wide" disabled={!menu.text.trim()}>Save</button>
              <button type="button" className="ph-plain ph-wide" onClick={() => setMenu(null)}>Cancel</button>
            </form>
          </Sheet>
        )}
        {menu?.kind === "project" && menuProject && (() => {
          const link = hostOf(menuProject);
          const count = panes.filter((pane) => pane.workspaceId === menuProject.id && pane.kind === "chat" && !pane.archived).length;
          return (
            <Sheet title={menuProject.name} onClose={() => setMenu(null)}>
              <div className="ph-card">
                <p><span className={`ph-dot${link?.status === "online" ? " on" : link?.status === "offline" ? " off" : ""}`} /><strong>{link?.name ?? workspaceHost(menuProject)}</strong> · {link ? link.status === "online" ? "Connected" : downLine(link) : "Not paired with this phone"}</p>
                {menuProject.path && <p className="ph-path">{menuProject.path}</p>}
                <p className="ph-meta">{threadCount(count)}</p>
              </div>
              <MenuRow label="New thread here" onClick={() => startIn(menuProject)} />
              <MenuRow label={menuProject.pinned ? "Unpin project" : "Pin project"} onClick={() => {
                saveSession((current) => ({ ...current, workspaces: current.workspaces.map((item) => item.id === menuProject.id ? { ...item, pinned: item.pinned ? undefined : true } : item) })).catch((error) => setNotice(words(error)));
                setMenu(null);
              }} />
              {menuProject.path && <MenuRow label="Copy folder path" detail={folderCopyText(menuProject.path)} onClick={() => { copyPath(menuProject.path); setMenu(null); }} />}
            </Sheet>
          );
        })()}
        {browse && (
          <Sheet title="Choose a folder" onClose={() => setBrowse(null)}>
            <p className="ph-sheet-text">{browse.projectName ? `For ${browse.projectName} on ${linkOf(browse.hostId)?.name ?? browse.hostId}.` : `New project on ${linkOf(browse.hostId)?.name ?? browse.hostId}.`}{browse.macCopy ? ` This is a separate copy from ${mac?.name ?? "your Mac"}'s. Nothing is copied over.` : ""}</p>
            {browse.error && <p className="ph-sheet-text ph-red">{browse.error}</p>}
            {!browse.listing && !browse.error && <p className="ph-sheet-text">Opening {linkOf(browse.hostId)?.name ?? "the machine"}…</p>}
            {browse.listing && <>
              <p className="ph-path">{browse.listing.path}</p>
              {browse.listing.parent !== null && <button type="button" className="ph-srow" onClick={() => { void phoneHost(browse.hostId)?.backend.listFolder(browse.listing?.parent ?? null).then((listing) => setBrowse((current) => current ? { ...current, listing, path: listing.path, error: "" } : current)).catch((error) => setNotice(words(error))); }}><span className="ph-srow-icon"><ArrowLeft size={18} /></span><span className="ph-grow"><strong>Up</strong></span></button>}
              {browse.listing.folders.map((name) => (
                <button key={name} type="button" className="ph-srow" onClick={() => {
                  const path = `${browse.listing!.path.replace(/\/$/, "")}/${name}`;
                  void phoneHost(browse.hostId)?.backend.listFolder(path).then((listing) => setBrowse((current) => current ? { ...current, listing, path: listing.path, error: "" } : current)).catch((error) => setNotice(words(error)));
                }}><span className="ph-srow-icon"><Folder size={18} /></span><span className="ph-grow"><strong>{name}</strong></span><ChevronRight size={16} /></button>
              ))}
              <button type="button" className="primary ph-wide" onClick={() => { if (browse.listing) void useFolder(browse.listing.path).catch((error) => setNotice(words(error))); }}>Use this folder</button>
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
        <div className="ph-handle" />
        <div className="ph-sheet-title">
          <h3>{title}</h3>
          <button type="button" className="ph-icon" aria-label="Close" onClick={onClose}><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function MenuRow({ label, detail, danger, onClick }: { label: string; detail?: string; danger?: boolean; onClick(): void }) {
  return (
    <button type="button" className={`ph-srow${danger ? " ph-red" : ""}`} onClick={onClick}>
      <span className="ph-grow"><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
    </button>
  );
}

function ThreadList({ sections, workspaces, links, folded, pending, draft, waiting, covered, machineIcon, onToggle, onOpen, onNew, onThreadMenu, onProjectMenu, onMachines }: {
  sections: ReturnType<typeof sidebarSections>;
  workspaces: Workspace[];
  links: LinkView[];
  folded: Record<string, boolean>;
  pending: Pending | null;
  draft: Draft;
  waiting: Record<string, string[]>;
  covered: boolean;
  machineIcon(hostId: string, size?: number): ReactNode;
  onToggle(id: string): void;
  onOpen(id: string): void;
  onNew(workspace: Workspace): void;
  onThreadMenu(id: string): void;
  onProjectMenu(id: string): void;
  onMachines(): void;
}) {
  const press = useLongPress();
  const linkFor = (workspace: Workspace) => links.find((link) => link.id === workspaceHost(workspace));
  const nameOf = (workspace: Workspace) => linkFor(workspace)?.name ?? workspaceHost(workspace);
  const down = links.filter((link) => link.status !== "online" && (link.problem || link.status === "offline"));
  // One line inside its project; Pinned and Recents add where it runs. The menu is a long-press, as on iOS.
  const row = (pane: Pane, nested = false) => {
    const workspace = workspaces.find((item) => item.id === pane.workspaceId);
    const link = workspace ? linkFor(workspace) : undefined;
    const off = link?.status === "offline";
    const asking = !off && (waiting[pane.id]?.length ?? 0) > 0;
    const state = off ? "Offline" : asking ? "Waiting on you" : "";
    return (
      <div key={pane.id} className="ph-row">
        <button type="button" className="ph-item" aria-haspopup="menu" {...press.bind(() => onThreadMenu(pane.id))} onClick={() => { if (!press.held.current) onOpen(pane.id); }}>
          <span className="ph-line">
            <i className={`ph-dot${off ? " off" : asking ? " wait" : ""}`} title={off ? "Machine offline" : asking ? "Waiting on you" : "Idle"} />
            <strong className={pane.unread ? "ph-bold" : undefined}>{pane.title}</strong>
            {pane.unread && <span className="ph-unread" aria-label="Unread" />}
            <span className="ph-time">{pane.activeAt ? ageWords(Date.now() - pane.activeAt) : "New"}</span>
          </span>
          {(!nested || state) && (
            <small className={asking ? "ph-amber" : undefined}>
              {state}{state && !nested ? " · " : ""}
              {!nested && workspace && <>{machineIcon(workspaceHost(workspace), 12)}<span className="ph-ellipsis">{workspace.name} · {nameOf(workspace)}</span></>}
            </small>
          )}
        </button>
      </div>
    );
  };
  return (
    <main className="ph-content" inert={covered}>
      {links.length === 0 && (
        <div className="ph-welcome">
          <img className="ph-logo" src="/branding/logo-dark.svg" alt="Apex Deck" width="150" height="161" />
          <strong>Pair this phone with your Mac</strong>
          <p>Then pair each server on its own, so a sleeping Mac doesn't cut them off.</p>
          <button type="button" className="primary ph-wide" onClick={onMachines}>Open Machines</button>
        </div>
      )}
      {down.map((link) => (
        <button key={link.id} type="button" className={`ph-banner ph-banner-button${link.problem ? " bad" : ""}`} onClick={onMachines}>
          <strong>{link.problem ? `${link.name} can't connect` : `${link.name} is ${link.kind === "mac" ? "asleep" : "offline"}`}</strong>
          <p>{downLine(link)}</p>
        </button>
      ))}
      {sections.pinned.length > 0 && <><div className="ph-section">PINNED</div><div className="ph-group">{sections.pinned.map((pane) => row(pane))}</div></>}
      {sections.projects.length > 0 && <div className="ph-section">PROJECTS</div>}
      {sections.projects.length > 0 && (
        <div className="ph-group">
          {sections.projects.map(({ workspace, panes: projectPanes }) => {
            const hostId = workspaceHost(workspace);
            const link = linkFor(workspace);
            const closed = folded[workspace.id] ?? Boolean(workspace.collapsed);
            const showDraft = pending?.workspaceId === workspace.id && draftVisible(draft.text, draft.files.length);
            const threads = projectPanes.filter((pane) => pane.kind === "chat");
            return (
              <div key={workspace.id} className="ph-project">
                <div className="ph-row">
                  <button type="button" className="ph-item" aria-expanded={!closed} {...press.bind(() => onProjectMenu(workspace.id))} onClick={() => { if (!press.held.current) onToggle(workspace.id); }}>
                    <span className="ph-project-name">
                      <span className="ph-chevron" style={{ transform: closed ? undefined : "rotate(90deg)" }}><ChevronRight size={14} /></span>
                      <span className="ph-ellipsis ph-project-title">{workspace.name}</span>
                      <span className="ph-project-host">
                        {hostId === "local" ? <i className={`ph-dot${link?.status === "online" ? " on" : link?.status === "offline" ? " off" : ""}`} /> : machineIcon(hostId, 12)}
                        <span className="ph-ellipsis">{nameOf(workspace)}{link?.problem ? " · can't connect" : link?.status === "offline" ? " · offline" : ""}</span>
                      </span>
                    </span>
                  </button>
                  <button type="button" className="ph-icon ph-quiet" aria-label={`New thread in ${workspace.name} on ${nameOf(workspace)}`} onClick={() => onNew(workspace)}><Plus size={18} /></button>
                  <button type="button" className="ph-icon ph-quiet" aria-label={`Project actions ${workspace.name} ${nameOf(workspace)}`} onClick={() => onProjectMenu(workspace.id)}><More size={18} /></button>
                </div>
                {!closed && (
                  <div className="ph-nested">
                    {showDraft && pending && (
                      <div className="ph-row">
                        <button type="button" className="ph-item" onClick={() => onOpen(pending.id)}>
                          <span className="ph-line"><i className="ph-dot" /><strong>{draft.text.trim().split("\n")[0].slice(0, 40) || "New thread"}</strong><span className="ph-time">Draft</span></span>
                        </button>
                      </div>
                    )}
                    {threads.map((pane) => row(pane, true))}
                    {threads.length === 0 && !showDraft && <p className="ph-none">No threads</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {sections.recents.length > 0 && <><div className="ph-section">RECENTS</div><div className="ph-group">{sections.recents.slice(0, 4).map((pane) => row(pane))}</div></>}
      {links.length > 0 && <p className="ph-foot">Hold a thread or project for its menu.</p>}
    </main>
  );
}

function ThreadView(props: {
  title: string; draftThread: boolean; project: string; machine: string; path: string; kind: MachineKind; link: LinkView;
  hostIcon: ReactNode; started: boolean; covered: boolean;
  messages: Message[]; approvals: { id: string; request: string; action: import("../types").ProposedAction }[];
  participants: { id: string; display_name: string }[]; draft: Draft; gate: { enabled: boolean; reason: string };
  fork?: Pane["fork"]; approvalStays: boolean; other: LinkView | null; endRef: RefObject<HTMLDivElement | null>;
  onBack(): void; onMenu(): void; onDraft(text: string): void; onRemoveFile(name: string): void;
  sending: boolean; attaching: boolean; onSend(): void; onDecide(request: string, approve: boolean, always: boolean): Promise<void>; onRetry(): void;
  onOpenOther(hostId: string): void; onSheet(sheet: SheetKind): void;
  /** The question or next steps, above the composer. */
  form: ReactNode; plan: boolean; onStopPlanning(): void;
}) {
  const paused = props.link.status !== "online";
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Size the box to its text whenever the draft loads or changes, not only while typing.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }, [props.draft.text]);
  const nameOf = (id: string) => props.participants.find((participant) => participant.id === id)?.display_name ?? id;
  const short = props.project.length > 18 ? `${props.project.slice(0, 7)}…${props.project.slice(-7)}` : props.project;
  return (
    <>
      <header className="ph-nav" inert={props.covered}>
        <button type="button" className="ph-icon ph-nav-back" aria-label="Back to Threads" onClick={props.onBack}><ChevronLeft size={26} /></button>
        <div className="ph-nav-title">
          <h2>{props.draftThread ? "New thread" : props.title}</h2>
          <p className="ph-context"><span className="ph-ellipsis" title={props.project}>{short}</span><span>&nbsp;· {props.machine}</span></p>
        </div>
        {props.draftThread
          ? <span className="ph-nav-spacer" />
          : <button type="button" className="ph-icon" aria-label="Thread actions" onClick={props.onMenu}><More size={20} /></button>}
      </header>
      <main className="ph-content ph-chat" inert={props.covered}>
        {props.participants.length > 0 && (
          <div className="ph-people">
            {props.participants.slice(0, 4).map((participant) => (
              <span key={participant.id} className="ph-avatar" style={{ "--bot": botTint(participant.display_name) } as CSSProperties}>{participant.display_name.slice(0, 1)}</span>
            ))}
            <span className="ph-grow">{props.participants.map((participant) => participant.display_name).join(" · ")}<small> · shared group thread</small></span>
          </div>
        )}
        {props.fork && <p className="ph-banner">{forkLine(props.fork, props.messages.length, props.approvalStays)}</p>}
        {paused && (
          <div className={`ph-banner${props.link.problem ? " bad" : ""}`} role="status">
            <strong>{props.link.problem ? `${props.machine} can't connect` : `${props.machine} ${props.kind === "mac" && props.link.status === "offline" ? "is asleep" : props.link.status === "offline" ? "is offline" : "is connecting"}`}</strong>
            <p>{downLine(props.link)}. Nothing is queued, and your text stays here.</p>
            <div className="ph-banner-actions">
              {!props.link.problem && <button type="button" onClick={props.onRetry}>Retry now</button>}
              {props.kind === "mac" && props.other && <button type="button" onClick={() => props.onOpenOther(props.other!.id)}>Open {props.other.name} thread</button>}
            </div>
          </div>
        )}
        {props.messages.length === 0 && !paused && (
          <div className="ph-empty">
            <MessageSquare size={30} />
            <h3>What are we working on?</h3>
            <p>{props.project} · {props.machine}{props.path && <><br />{props.path}</>}</p>
          </div>
        )}
        {props.messages.map((message) => message.speaker.kind === "human" ? (
          <section key={message.seq} className="ph-msg human">
            <div className="ph-by">You</div>
            <p>{message.text}</p>
          </section>
        ) : (
          <section key={message.seq} className="ph-msg">
            <div className="ph-by"><span className="ph-avatar small" style={{ "--bot": botTint(nameOf(message.speaker.id)) } as CSSProperties}>{nameOf(message.speaker.id).slice(0, 1)}</span>{nameOf(message.speaker.id)}</div>
            <div className="ph-md"><Markdown text={message.text} onOpen={(target) => { if (/^https?:/i.test(target)) window.open(target, "_blank", "noopener"); }} /></div>
          </section>
        ))}
        {props.approvals.map((card) => (
          <div key={card.request} className="ph-approval">
            <ApprovalCard action={card.action} request={card.request} by={card.id} name={nameOf(card.id)} hostName={approvalWhere(props.machine, props.path, props.kind)} disabled={paused} onDecide={(approve, always) => props.onDecide(card.request, approve, always)} />
          </div>
        ))}
        <div ref={props.endRef} />
      </main>
      <form className={`ph-composer${props.plan ? " plan" : ""}`} inert={props.covered} onSubmit={(event) => { event.preventDefault(); props.onSend(); }}>
        {props.form}
        <div className="ph-workbar">
          <button type="button" aria-label={`Project ${props.project}`} onClick={() => props.onSheet("project")}><Folder size={16} /><span>{short}</span></button>
          <button type="button" aria-label="Files" onClick={() => props.onSheet("files")}><Files size={17} /><span className="ph-wb-word">Files</span>{props.draft.files.length > 0 && <b className="ph-count">{props.draft.files.length}</b>}</button>
          <button type="button" aria-label="Tools" onClick={() => props.onSheet("tools")}><Plug size={17} /><span className="ph-wb-word">Tools</span></button>
          <button type="button" aria-label={`Work in ${props.machine}`} onClick={() => props.onSheet("work")}>{props.started ? <Lock size={15} /> : props.hostIcon}<span>{props.machine}</span></button>
        </div>
        {props.plan && <button type="button" className="plan-chip ph-plan" aria-label="Plan is on. Turn it off" onClick={props.onStopPlanning}><span aria-hidden="true">◇</span><span className="plan-chip-label">Plan</span><span className="plan-chip-x" aria-hidden="true">✕</span></button>}
        {props.draft.files.length > 0 && (
          <div className="ph-chips">
            {props.draft.files.map((file) => (
              <span key={file.name} className="ph-chip"><Paperclip size={13} />{file.name}<button type="button" aria-label={`Remove ${file.name}`} onClick={() => props.onRemoveFile(file.name)}><X size={14} /></button></span>
            ))}
          </div>
        )}
        <div className="ph-input">
          <textarea ref={inputRef} aria-label="Message this thread" rows={1} value={props.draft.text} placeholder={props.plan ? "Plan with the bots — nothing gets changed…" : "Message the group…"}
            onChange={(event) => props.onDraft(event.target.value)} />
          <button type="submit" className="ph-send" aria-label={props.sending ? `Sending to ${props.machine}` : props.attaching ? "Attaching a file" : `Send to ${props.machine}`} disabled={!props.gate.enabled || props.sending || props.attaching}><ArrowUp size={21} /></button>
        </div>
        {paused && <p className="ph-caption warn">{props.gate.reason}</p>}
      </form>
    </>
  );
}

function ProjectSheet({ rows, links, query, machineIcon, onQuery, onPick }: { rows: PickerRow[]; links: LinkView[]; query: string; machineIcon(hostId: string, size?: number): ReactNode; onQuery(value: string): void; onPick(workspace: Workspace): void }) {
  const shown = rows.filter((row) => pickerMatches(row, links.find((link) => link.id === row.hostId)?.name ?? row.hostId, query));
  return (
    <>
      <input className="ph-search" type="search" placeholder="Search projects…" value={query} onChange={(event) => onQuery(event.target.value)} aria-label="Search projects" />
      {shown.length === 0 && <p className="ph-sheet-text">No projects match.</p>}
      {shown.map((row) => {
        const link = links.find((item) => item.id === row.hostId);
        return (
          <button key={row.workspace.id} type="button" className="ph-srow" disabled={row.offline && !row.current} onClick={() => onPick(row.workspace)}>
            <span className="ph-srow-icon"><Folder size={18} /></span>
            <span className="ph-grow">
              <strong>{row.workspace.name}</strong>
              <small>{link?.name ?? row.hostId} · {homeShort(row.workspace.path) || "no folder"}{row.offline && link ? ` · ${downLine(link)}` : ""}</small>
            </span>
            {row.current ? <span className="ph-srow-icon"><Check size={18} /></span> : machineIcon(row.hostId)}
          </button>
        );
      })}
    </>
  );
}

function WorkSheet({ rows, links, workspaces, project, mac, stays, machineIcon, onPick, onBrowse, onNone }: {
  rows: ReturnType<typeof workInRows>; links: LinkView[]; workspaces: Workspace[]; project: string; mac: LinkView | null; stays: string | null;
  machineIcon(hostId: string, size?: number): ReactNode; onPick(workspace: Workspace): void; onBrowse(hostId: string): void; onNone(): void;
}) {
  return (
    <>
      {stays && <p className="ph-sheet-text"><Lock size={13} /> This thread stays on {stays}. Picking another machine offers a new thread or a fork.</p>}
      <p className="ph-sheet-text">Each machine keeps its own copy of {project}. Nothing is copied between them.</p>
      {rows.map((row) => {
        const link = links.find((item) => item.id === row.hostId);
        const workspace = row.workspaceId ? workspaces.find((item) => item.id === row.workspaceId) ?? null : null;
        return (
          <button key={`${row.hostId}:${row.path}`} type="button" className="ph-srow" disabled={row.offline && !row.current} onClick={() => workspace ? onPick(workspace) : onBrowse(row.hostId)}>
            {machineIcon(row.hostId, 18)}
            <span className="ph-grow">
              <strong><i className={`ph-dot${link?.status === "online" ? " on" : row.offline ? " off" : ""}`} />{link?.name ?? row.hostId}</strong>
              <small>{row.path ? homeShort(row.path) : "No copy yet · choose a folder"}{row.offline && link ? ` · ${downLine(link)}` : ""}</small>
            </span>
            {row.current ? <span className="ph-srow-icon"><Check size={18} /></span> : <ChevronRight size={16} />}
          </button>
        );
      })}
      <button type="button" className="ph-plain ph-wide" onClick={onNone}>Don't work in a project{mac && mac.status !== "online" ? ` · ${downLine(mac)}` : ""}</button>
    </>
  );
}

function Machines({ machines, links, covered, machineIcon, missing, confirm, onAdd, onUnpair, onConfirm, onRetry, onError }: {
  machines: DirectMachine[]; links: LinkView[]; covered: boolean; machineIcon(hostId: string, size?: number): ReactNode; missing: string[]; confirm: string | null;
  onAdd(machine: DirectMachine): void; onUnpair(id: string): void; onConfirm(id: string | null): void; onRetry(id: string): void; onError(message: string): void;
}) {
  const hasMac = machines.some((machine) => machine.kind === "mac");
  const blank = (kind: MachineKind) => ({ name: "", url: "", token: "", kind, id: kind === "server" ? missing[0] ?? "" : "" });
  const [form, setForm] = useState(() => blank(hasMac ? "server" : "mac"));
  const [adding, setAdding] = useState(machines.length === 0);
  return (
    <main className="ph-content" inert={covered}>
      <h2>Machines</h2>
      <p className="ph-intro">This phone connects to each machine itself. Servers stay reachable when your Mac sleeps.</p>
      {machines.map((machine) => {
        const link = links.find((item) => item.id === machine.id);
        const state = !link ? "Connecting…" : link.status === "online" ? "Connected" : link.problem ? "Can't connect" : link.status === "offline" ? machine.kind === "mac" ? "Asleep or unreachable" : "Offline" : "Connecting…";
        return (
          <div key={machine.id} className={`ph-group ph-padded${link?.problem ? " bad" : ""}`}>
            <h3>{machineIcon(machine.id, 18)} {machine.name}</h3>
            <p className="ph-muted"><i className={`ph-dot${link?.status === "online" ? " on" : link?.status === "offline" ? " off" : ""}`} />{state} · paired with this phone</p>
            {link && link.status !== "online" && link.status !== "connecting" && <p className={link.problem ? "ph-red" : "ph-muted"}>{downLine(link)}</p>}
            <p className="ph-path">{machine.url}{machine.kind === "server" ? ` · id ${machine.id}` : ""}</p>
            {link && link.status === "offline" && !link.problem && <button type="button" className="ph-wide" onClick={() => onRetry(machine.id)}>Retry now</button>}
            {confirm === machine.id
              ? <>
                <p className="ph-muted">Its threads stay on {machine.name}. You can pair it again later.</p>
                <button type="button" className="danger ph-wide" onClick={() => onUnpair(machine.id)}>Unpair {machine.name}</button>
                <button type="button" className="ph-plain ph-wide" onClick={() => onConfirm(null)}>Cancel</button>
              </>
              : <button type="button" className="ph-plain ph-wide" onClick={() => onConfirm(machine.id)}>Unpair…</button>}
          </div>
        );
      })}
      {missing.length > 0 && <p className="ph-intro">Your Mac's threads also use {missing.join(", ")}. Pair each one with its address so those threads work here too.</p>}
      {!adding && <button type="button" className="primary ph-wide" onClick={() => { setForm(blank(hasMac ? "server" : "mac")); setAdding(true); }}>Add a machine…</button>}
      {adding && (
        <form className="ph-group ph-padded ph-form" onSubmit={(event) => {
          event.preventDefault();
          try {
            onAdd({ id: form.kind === "mac" ? "local" : form.id.trim(), name: form.name, kind: form.kind, url: form.url, token: form.token });
            setAdding(false);
          } catch (error) { onError(words(error)); }
        }}>
          <img className="ph-logo-wide" src="/branding/logo-horizontal.svg" alt="Apex Deck" width="160" height="40" />
          <h3>Add a machine</h3>
          <div className="ph-segment" role="radiogroup" aria-label="Kind">
            <button type="button" role="radio" aria-checked={form.kind === "mac"} disabled={hasMac} onClick={() => setForm({ ...form, kind: "mac", id: "" })}><Laptop size={16} />Mac</button>
            <button type="button" role="radio" aria-checked={form.kind === "server"} onClick={() => setForm({ ...form, kind: "server", id: form.id || missing[0] || "" })}><Globe size={16} />Server</button>
          </div>
          <label className="ph-label">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={form.kind === "mac" ? "Tyler's MacBook" : "Apex-Terminal"} required autoCapitalize="words" /></label>
          {form.kind === "server" && <label className="ph-label">Id<input value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} placeholder={missing[0] ?? "h-…"} required autoCapitalize="off" autoCorrect="off" spellCheck={false} /><small>{missing.length > 0 ? `The id your Mac uses for it: ${missing.join(" or ")}` : "The id your Mac uses for this server"}</small></label>}
          <label className="ph-label">Address<input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="ws://192.168.1.10:7421" required inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
          <label className="ph-label">Daemon token<input type="password" value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value.trim() })} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} required /><small>Paste only the token. Spaces and line breaks are removed.</small></label>
          <button type="submit" className="primary ph-wide">Pair {form.kind === "mac" ? "Mac" : "server"}</button>
          {machines.length > 0 && <button type="button" className="ph-plain ph-wide" onClick={() => setAdding(false)}>Cancel</button>}
        </form>
      )}
      <p className="ph-foot">The token works like a password. It stays on this phone.</p>
    </main>
  );
}

function SideTab({ tab, link, agents, covered, onShow }: { tab: Tab; link: LinkView | null; agents: string[]; covered: boolean; onShow(): void }) {
  useEffect(() => { if (tab === "agents") onShow(); }, [tab, link?.id, link?.status]);
  const offline = !link || link.status !== "online";
  return (
    <main className="ph-content" inert={covered}>
      {link && <p className="ph-intro"><i className={`ph-dot${link.status === "online" ? " on" : link.status === "offline" ? " off" : ""}`} />Follows {link.name}</p>}
      {!link && <div className="ph-empty"><h3>Pair a machine first</h3><p>Open Settings → Machines.</p></div>}
      {link && offline && <div className="ph-banner"><strong>{link.name} can't be reached</strong><p>{downLine(link)}</p></div>}
      {link && !offline && tab === "agents" && (agents.length === 0
        ? <div className="ph-empty"><h3>No coding agents found</h3><p>Nothing installed on {link.name} yet.</p></div>
        : <div className="ph-group">{agents.map((agent) => <div key={agent} className="ph-srow ph-inset"><span className="ph-avatar" style={{ "--bot": botTint(agent) } as CSSProperties}>{agent.slice(0, 1)}</span><span className="ph-grow"><strong>{agent}</strong><small>Ready on {link.name}</small></span></div>)}</div>)}
      {link && !offline && tab === "code" && <div className="ph-empty"><Terminal size={30} /><h3>Terminals aren't on the phone yet</h3><p>Terminals and the browser run on {link.name}. Open them from the Mac for now.</p></div>}
      {link && !offline && tab === "library" && <div className="ph-empty"><Folder size={30} /><h3>Library isn't on the phone yet</h3><p>It will follow {link.name}.</p></div>}
    </main>
  );
}
