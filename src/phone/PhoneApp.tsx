import { createPhoneVoice, type PhoneVoice } from './phoneVoice.ts';
import { postFromPhone } from './phonePost.ts';
import { keepAwake } from './callScreen.ts';
import { VoiceCall, PhoneCallBar, PhoneCallCapsule, PhoneCallStrip, usePhoneCallSlot, type PhoneVoiceWho } from './VoiceCall.tsx';
import { composerButton, type CallLook } from '../voice/callView.ts';
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";

import { botChangeGate, botSendGate } from "../phoneBots";
import { AppearanceSettings } from "../AppearanceSettings";
import { defaultAppearanceSettings, type AppearanceSettings as AppearanceState } from "../themes";
import { applyPhoneTheme, loadPhoneAppearance, savePhoneAppearance } from "./appearance";
import { ApprovalCard } from "../ApprovalCard";
import { Avatar } from "../Avatar";
import { ApexAgentSources } from "../ApexAgentSources";
import { assistantDisplayName } from "../assistantName.ts";
import { ApexAgentAll } from "../ApexAgentAll";
import { usePersonalAssistant, type PersonalLane } from "../personalAssistant";
import "../apex-agent-dock.css";
import { currentAssistantRegistry, emptyAssistantRegistry, mergeAssistantPanes, reduceAssistantSnapshot, type AssistantRegistryState } from "../assistantRegistry";
import { ReasoningSlider } from "../ReasoningSlider";
import { SPEED_OPTIONS, speedHint } from "../speed";
import { latestSaveQueue } from "../settingsSave";
import { elapsed } from "../composerStatus";
import { legacyAppearance } from "../identicon";
import { Markdown } from "../Markdown";
import { SavedSteps, WorkSteps } from "../WorkSteps.tsx";
import { createStepsIndexLoader, dropStepsFrom, readReplySteps, rememberSteps, savedEntry } from "../workSteps.ts";
import { PreparingCard } from "../interactiveAnswers/AnswerCard.tsx";
import { CARD_LANGUAGE } from "../interactiveAnswers/contract.ts";
import { cardVersions } from "../interactiveAnswers/share.ts";
import { ThreadCard } from "../interactiveAnswers/ThreadCard.tsx";
import { QuestionForm } from "../QuestionForm";
import { applyQuestionEvent, formView, restoreQuestions, type ThreadAsks } from "../questions";
import { withAttachments } from "../attachments";
import { loadTldr, saveTldr, splitTldr, wiggle, withTldr } from "../tldr";
import { appendToolToken } from "../composerMenu";
import { chooseOutcome, pickerMatches, pickerRows, workInRows, type PickerRow } from "../destinations";
import { buildNotice, dotState, helperNotice } from "../hostFacts";
import type { HostConnection } from "../hostConnections";
import { workspaceFamily, workspaceHost } from "../hostSession";
import { openPhoneHost, type PhoneHost } from "../phoneBackend";
import { PhoneTerminal } from "./PhoneTerminal";
import { phoneShell } from "../phoneShell";
import { giveBack, queueHears, queueSync, queuedSticky, queuedViews, type QueuedView } from "../phoneQueue";
import { ParticipantQueues, type ParticipantMessage } from "../turnQueue";
import { applyCutEvent, applyTurnEvent, busyAfter, cutLine, cutOff, endedLine, resumeCut, turnWords, workingFrom, type PhoneCuts, type PhoneWorking } from "../phoneWorking";
import {
  addMachine, editMachine, approvalWhere, botMeters, crewOpen, downLine, draftVisible, forkLine, loadMachines, machinesKey, mentionPicks, newThreadGate,
  apiModelChoices, apiProviderName, modelChoices, pickMention, pillMeter, pressNewThread, reasoningLevels, refusalLine, removeMachine, saveMachines, settingsLine, tagFromBar, threadCount,
  pillDrag, threadSend, threadTitleFromMessage, tokenWords, toolLine, toolRows, toolSearch, withPhoneChange, phoneSpeed,
  canSeeNewThread, connectionKey, isPaired, withHints,
  type DirectMachine, type Machine, type PairedMachine, type MeterRow, type TurnChange, type LinkStatus, type LinkView, type MachineKind,
} from "../phoneRules";
import { recipientName } from "../recipients";
import { mentionFor } from "../slug";
import { ageWords, homeShort, hostTints, noteActive, sidebarSections, unarchiveThreads } from "../sidebarModel";
import { webSocketConnect } from "../daemon/webSocketLink";
import { FinalError, type Connect } from "../daemon/client";
import { irohConnect } from "../daemon/irohLink";
import { remotePlugin, type Route } from "./remotePlugin";
import { clearRemoteMode, defaultAddHow, PAIR_MACHINE_HINT, startAutomatic, whenAutomatic } from "./automatic";
import { AddHowPicker } from "./AddHow";
import { PairSheet } from "./PairSheet";
import { PhoneLibrary } from "./PhoneLibrary";
import { ComposerPanel, type ComposerAttachment } from "./ComposerPanel";
import { composerPlanDisabledReason, readCapturedFiles, setPlanBeforeContinuation } from "./composerPanelModel";
import { ThreadList } from "./ThreadList";
import { forkedPane, forkUpto } from "./messageFork";
import { GoBackAsk, MessageActions, type GoingBack } from "./MessageActions";
import { PickedText } from "./PickedText";
import { cutBack, needsFull, outgoingText, putBackLine, quotesBack, withQuote } from "./messageTools";
import { pinSource, pinText, responsePin } from "../messagePins";
import { handOffChoices, handOffLabel, MORE_DETAILS, moreDetailsText, partQuote, quoteFor, quoteTarget, type ReplyQuote } from "../reply";
import { failedLine, goBackAlways, goBackAsks, goBackRequest, initialFiles, saveGoBackAlways, type GoBack } from "../revertConfirm";
import { archivedDetail, foldChoice, readFolds } from "./threadListRules";
import { removeProjectFrom, removeProjectWords, restoreProjectTo, type RemovedProject } from "./projectRemoval";
import { serialEdits, stopProjectPanes } from "./sessionEdits";
import { UNDO_MS } from "../closing";
import type { PhoneLibraryMachine } from "./libraryMachines";
import { parsePairingLink, scansAtLaunch, withPairedMachine } from "./pairing";
import { createPairingGate, openIncomingLinks, reserveLocal, routePairingLink, settlePairing, shouldAutoScan, takeScan, type LinkOutcome, type PairingGate } from "./incomingLinks";
import { ScanCodeButton } from "./ScanCodeButton";
import { qrScanner } from "./remotePlugin";
import { createRoomRecovery, loadRoomState, representedRoomEvent } from "../roomRecovery";
import { mergePhoneSessionChange } from "../sessionSync";
import type { AssistantTaskOwner, AssistantTaskSnapshot } from "../assistantTaskModel";
import type { ProjectMonitor } from "../apexAgentModel";
import { folderCopyText, writeClipboard } from "../threadCopy";
import { historyHasAttachments, placeThread, MoveRefused } from "../threadMove";
import { mergePlan, percent } from "../battery";
import { planKey, planOf } from "../plans";
import type { AgentTool, ApiModel, AppSession, FolderListing, Message, ModelChoice, NextStep, Pane, ParticipantConfig, PlanWindow, ResetCredits, RoomEvent, RoomOptions, RoomState, Speed, TokenTotals, ToolServer, TurnPolicy, Workspace } from "../types";
import { addFolders } from "../workspaces";
import {
  ArrowLeft, ArrowUp, Check, CheckCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Command, Folder, Globe, Laptop, Lock, MessageSquare,
  More, Paperclip, Plug, Plus, Settings, Terminal, X,
} from "./icons";
import { PhoneResets } from "./PhoneResets";

const NO_ASKS: ThreadAsks = { questions: [], offer: null };

const SESSION_KEY = "apex-deck.phone.session.v1";
const DRAFT_KEY = "apex-deck.phone.drafts.v1";
const FOLDS_KEY = "apex-deck.phone.folds.v1";
/** The bot bar under a thread's title: "shut" when folded into the title bar. One choice for every thread, kept on this phone. */
const CREW_KEY = "apex-deck.phone.crew.v1";
const NEW_THREAD: RoomOptions = { policy: "mention", max_bot_hops: 3 };

type Tab = "threads" | "agents" | "code" | "library" | "machines" | "settings" | "appearance";
type Draft = { text: string; files: ComposerAttachment[] };
/** A message on its way, as it was in the box: its text and files, and the quotes with their Send to. */
type QueuedDraft = { draft: Draft; quotes: ReplyQuote[]; inBox: boolean; failed?: boolean };
type Pending = { id: string; workspaceId: string };
type Ask = { paneId: string; workspaceId: string };
type SheetKind = "project" | "where" | "tools";
/** A bot in the open thread, with the pattern and colour it has on the desktop. */
type Person = { id: string; display_name: string; look: { seed: string; color: string } };
const NO_CUTS: PhoneCuts = {};
/** An open working line shows a bot's latest steps; older ones fold into a count. */
const MAX_STEPS_SHOWN = 6;
/** How long a message's Copy reads "Copied", as on the desktop. */
const COPIED_MS = 1500;
type SavedStepsFor = { id: string; index: import("../types").StepsIndex | null };
type Room = {
  id: string; messages: Message[]; approvals: { id: string; request: string; action: import("../types").ProposedAction }[]; participants: Person[]; asks: ThreadAsks; plan: boolean; policy: TurnPolicy;
  /** Each bot's turn in progress, with its reply so far. */
  working: PhoneWorking;
  /** The bots as saved in the thread, for what each runs on. */
  configs: ParticipantConfig[];
  /** Context each bot's latest request filled, and each provider's plan, as reported while the thread is open. */
  fill: Record<string, { used: number; window: number }>;
  /** Keyed by plans.ts's planKey: a provider's figure, or one model's own quota group. */
  plans: Record<string, PlanWindow[]>;
  /** Usage resets each provider granted, as last reported; kept when a report doesn't list them. */
  credits: Partial<Record<AgentTool, ResetCredits>>;
  /** Tokens each bot has used in this thread, as saved with it and added to after each turn. */
  used: Record<string, TokenTotals>;
  /** Pinned for every model in the thread; a pinned message keeps its seq. */
  pins: string[];
};
/** What a bar pill shows for one bot: context left as a hairline, and whether its plan is nearly used up. */
type PillMeter = { context: number | null; low: boolean; planLow: boolean };
/** Long-press or ⋯ on a row, + at the top of Threads, or renaming a thread. */
type Menu = { kind: "thread"; id: string } | { kind: "project"; id: string } | { kind: "new" } | { kind: "rename"; id: string; text: string } | { kind: "bots"; id: string }
  | { kind: "archived" } | { kind: "remove"; id: string };
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
const tabName = (tab: Tab) => tab[0].toUpperCase() + tab.slice(1);
/** ageWords says "now" for under a minute, which takes no "ago". */
const activeWords = (age: string) => age === "now" ? "Active now" : `Active ${age} ago`;
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

const toPerson = (config: ParticipantConfig): Person => ({ id: config.id, display_name: config.display_name, look: config.appearance ?? legacyAppearance(config.id) });
const TOOL_WORDS: Record<string, string> = { claude_code: "Claude Code", codex: "Codex", gemini: "Antigravity", grok: "Grok", muse: "Muse Code" };
/** What a saved bot runs on, in a few words. */
function toolWords(config: ParticipantConfig): string {
  const backend = config.backend;
  if (backend.kind === "agent") return [TOOL_WORDS[backend.tool] ?? backend.tool, backend.model].filter(Boolean).join(" · ");
  if (backend.kind === "open_ai_compatible") return [apiProviderName(config), backend.model].filter(Boolean).join(" · ");
  if (backend.kind === "cli") return backend.program;
  return "Scripted";
}

/**
 * A bot pill: tap to tag, hold or pull down to open its details. The pull is short and mostly
 * straight down; sideways goes to the bar's scroll. The chip follows the finger a little.
 */
function usePillPress() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const done = useRef(false);
  const [pull, setPull] = useState<{ id: string; y: number } | null>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const end = () => { clear(); start.current = null; setPull(null); };
  return {
    pull,
    bind: (who: string, open: () => void, tap: () => void) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        done.current = false; clear();
        start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
        if (event.pointerType === "mouse") event.currentTarget.setPointerCapture?.(event.pointerId);
        timer.current = setTimeout(() => { done.current = true; end(); open(); }, 500);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const from = start.current;
        if (!from || from.id !== event.pointerId || done.current) return;
        const dx = event.clientX - from.x, dy = event.clientY - from.y;
        const move = pillDrag(dx, dy);
        if (Math.hypot(dx, dy) > 6) clear();
        if (move === "scroll") { done.current = true; end(); return; }
        if (move === "open") { done.current = true; end(); navigator.vibrate?.(8); open(); return; }
        setPull(dy > 2 ? { id: who, y: Math.min(dy, 28) } : null);
      },
      onPointerUp: end,
      onPointerCancel: end,
      onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); clear(); done.current = true; open(); },
      onClick: () => { if (done.current) { done.current = false; return; } tap(); },
    }),
  };
}

export function PhoneApp() {
  const [appearance, setAppearance] = useState<AppearanceState>(() => {
    try { return loadPhoneAppearance(localStorage); } catch { return defaultAppearanceSettings(); }
  });
  const [appearanceSaveError, setAppearanceSaveError] = useState(false);
  const settingsReturn = useRef<Tab>("threads");
  /** Machines opens from Threads (Pair) or from Settings; its back button returns there. */
  const machinesReturn = useRef<Tab>("threads");
  useLayoutEffect(() => applyPhoneTheme(document.documentElement, appearance.current.appearance), [appearance]);
  const changeAppearance = (next: AppearanceState) => {
    setAppearance(next);
    try { setAppearanceSaveError(!savePhoneAppearance(localStorage, next)); }
    catch { setAppearanceSaveError(true); }
  };
  const [machines, setMachines] = useState<Machine[]>(() => loadMachines(typeof localStorage === "undefined" ? null : localStorage.getItem(machinesKey())));
  const [hosts, setHosts] = useState<PhoneHost[]>([]);
  const plugin = useMemo(() => remotePlugin(), []);
  /** One Automatic setup for this launch. The old Direct only key is deleted, not read. */
  const automaticReady = useRef<Promise<void> | null>(null);
  if (automaticReady.current === null) {
    try { clearRemoteMode(localStorage); } catch { /* storage may be unavailable; nothing is read back */ }
    automaticReady.current = startAutomatic(plugin);
  }
  const ready = automaticReady.current;
  /** Direct or Relayed for each QR-paired machine that's connected. */
  const [routes, setRoutes] = useState<Record<string, Route | null>>({});
  /** The newest saved list, for addresses learned after a connection opened. */
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const scanner = useMemo(() => qrScanner(), []);
  const [pairing, setPairing] = useState<{ link: string; kind: MachineKind; id: string; name: string; attempt: number } | null>(null);
  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;
  const attemptSeq = useRef(0);
  const gateRef = useRef<PairingGate | null>(null);
  const noticeRef = useRef<(message: string) => void>(() => {});
  const [tick, setTick] = useState(0);
  const [session, setSession] = useState<AppSession | null>(readSession);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const pendingSessionEvents = useRef<AppSession[]>([]);
  const sessionEventVersion = useRef(0);
  const phoneSaveTag = useRef(`phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const phoneSaveSeq = useRef(0);
  /** An empty list at launch opens the camera once, from Add a machine. On a phone, that waits until a launch link has been ruled out. */
  const [scanAtLaunch, setScanAtLaunch] = useState(() => !Capacitor.isNativePlatform() && scansAtLaunch(machines.length, Boolean(plugin && scanner)));
  const [tab, setTab] = useState<Tab>(() => (scanAtLaunch ? "machines" : "threads"));
  const linkResolve = useRef<((outcome: LinkOutcome) => void) | null>(null);
  const linkSeq = useRef(0);
  const [incomingLink, setIncomingLink] = useState<{ id: number; url: string; kind: "mac"; adding: true } | null>(null);
  const pairFromLinkRef = useRef<(url: string) => Promise<LinkOutcome>>(async () => "failed");
  pairFromLinkRef.current = (url) => new Promise((resolve) => {
    linkResolve.current = resolve;
    const route = routePairingLink();
    setIncomingLink({ id: ++linkSeq.current, url, kind: route.kind, adding: route.adding });
    setTab(route.tab);
  });
  const [terminalSwitcherOpen, setTerminalSwitcherOpen] = useState(false);
  const [terminalResumeSignal, setTerminalResumeSignal] = useState(0);
  const [terminalNeedsAnswer, setTerminalNeedsAnswer] = useState(false);
  /** A terminal is open on the Code tab, so the header shows ‹ Code; the back button bumps the home signal. */
  const [terminalViewing, setTerminalViewing] = useState(false);
  const [terminalHomeSignal, setTerminalHomeSignal] = useState(0);
  const codeHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeHeld = useRef(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(readDrafts);
  /** The project removed a moment ago, with what Undo needs. Cleared when its time runs out. */
  const [projectUndo, setProjectUndo] = useState<{ undo: RemovedProject; name: string } | null>(null);
  const projectUndoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // TL;DR mode is a per-thread switch, kept on the phone like the desktop keeps it per chat.
  const [tldrs, setTldrs] = useState<Record<string, boolean>>({});
  const tldrOf = (id: string | null) => id !== null && (tldrs[id] ?? loadTldr(id));
  const setTldr = (id: string, on: boolean) => { saveTldr(id, on); setTldrs((all) => ({ ...all, [id]: on })); };
  const [folded, setFolded] = useState<Record<string, boolean>>(() => { try { return readFolds(localStorage.getItem(FOLDS_KEY)); } catch { return {}; } });
  useEffect(() => { try { localStorage.setItem(FOLDS_KEY, JSON.stringify(folded)); } catch { /* retain choices for this session */ } }, [folded]);
  const [notice, setNotice] = useState("");
  noticeRef.current = setNotice;
  if (gateRef.current === null) gateRef.current = createPairingGate((message) => noticeRef.current(message));
  // Release the slot now. `close` is false when the error should stay on screen.
  const settle = (outcome: LinkOutcome, close: boolean) => {
    const current = pairingRef.current;
    const resolve = linkResolve.current;
    linkResolve.current = null;
    if (current && gateRef.current) settlePairing(gateRef.current, current.link, outcome, resolve);
    else if (resolve) resolve(outcome);
    if (close) setPairing(null);
  };
  const endLink = (outcome: Exclude<LinkOutcome, "paired">) => settle(outcome, true);
  // Listener first, then the launch link, before the camera is allowed to open.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const opened = openIncomingLinks({
      addListener: (event, listener) => App.addListener(event, listener),
      getLaunchUrl: () => App.getLaunchUrl(),
    }, (url) => pairFromLinkRef.current(url), {
      refuse: (message) => setNotice(message),
      invalid: (message) => setNotice(message),
      broken: (message) => setNotice(message),
    }, gateRef.current!);
    let live = true;
    void opened.launch.then((url) => {
      if (!live) return;
      if (shouldAutoScan(url, machinesRef.current.length, Boolean(plugin && scanner))) {
        setScanAtLaunch(true);
        setTab("machines");
      }
    });
    return () => {
      live = false;
      opened.close();
    };
  }, [plugin, scanner]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [assistantWorkspaceId, setAssistantWorkspaceId] = useState<string | null>(null);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [assistantRegistry, setAssistantRegistry] = useState<AssistantRegistryState>(() => emptyAssistantRegistry());
  const [assistantOwners, setAssistantOwners] = useState<Record<string, AssistantTaskOwner>>({});
  const [assistantRegistryErrors, setAssistantRegistryErrors] = useState<Record<string, string>>({});
  const [botChange, setBotChange] = useState<{ roomId: string; botId: string; error: string; pending: boolean } | null>(null);
  const botChangeLock = useRef(false);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const composerDestination = useRef<{ id: string | null; workspaceId: string | null } | null>(null);
  const pickerDraft = useRef<string | null>(null);
  const [pendingDraftPlans, setPendingDraftPlans] = useState<Record<string, boolean>>({});
  const pendingRoomIds = useRef<Record<string, Pane>>({});
  const [composerPlan, setComposerPlan] = useState<{ roomId: string | null; pending: boolean; error: string | null }>({ roomId: null, pending: false, error: null });
  const composerPlanLock = useRef(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  /** The bot whose details are open, from holding it in the bot bar. */
  const [botSheet, setBotSheet] = useState<string | null>(null);
  /** One key per reset asked for, by machine, provider and credit. Kept after a failure, so trying
   *  again can't spend a second credit if the first went through unseen. */
  const resetKeys = useRef(new Map<string, string>());
  /** Models each machine's tools offer, asked for when a bot's sheet opens. Keyed by machine and tool. */
  const [offered, setOffered] = useState<Record<string, ModelChoice[]>>({});
  /** What each API account offers and has left, asked for through a bot on it. Keyed by machine and account. */
  const [apiOffered, setApiOffered] = useState<Record<string, { models?: ApiModel[]; balance?: number | null }>>({});
  /** One save line per bot, so its model and reasoning reach the machine in the order they were picked. */
  const turnSaves = useRef(new Map<string, (save: { change: TurnChange; reported: ModelChoice[]; apiModels: ApiModel[] }) => Promise<void>>());
  const [crewShut, setCrewShut] = useState(() => { try { return localStorage.getItem(CREW_KEY) === "shut"; } catch { return false; } });
  const foldCrew = (shut: boolean) => {
    setCrewShut(shut);
    try { if (shut) localStorage.setItem(CREW_KEY, "shut"); else localStorage.removeItem(CREW_KEY); } catch { /* kept until the app closes */ }
  };
  const [query, setQuery] = useState("");
  const [tools, setTools] = useState<ToolServer[] | null>(null);
  const [toolQuery, setToolQuery] = useState("");
  const [browse, setBrowse] = useState<Browse | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  /** Per thread: who was working when its machine dropped, with what they had written. Kept until each reply lands,
   *  through a reload or leaving the thread. */
  const [cuts, setCuts] = useState<Record<string, PhoneCuts>>({});
  /** Per thread: messages quoted in the box, waiting to go with the next message, as on the desktop. */
  const [quotes, setQuotes] = useState<Record<string, ReplyQuote[]>>({});
  /** The Retry or Revert question open under a message. */
  const [goingBack, setGoingBack] = useState<GoingBack | null>(null);
  /** A pin or unpin is on its way; one at a time, as on the desktop. */
  const [pinning, setPinning] = useState(false);
  const pinPending = useRef(false);
  const [approvalStays, setApprovalStays] = useState<Record<string, boolean>>({});
  const [agents, setAgents] = useState<string[]>([]);
  const [confirmUnpair, setConfirmUnpair] = useState<string | null>(null);
  /** Approval cards open on each machine, by thread id, from that machine's events. */
  const [waiting, setWaiting] = useState<Record<string, string[]>>({});
  /** Newest message seen per thread on this phone, so Recents moves without a save to the Mac per message. */
  const [seen, setSeen] = useState<Record<string, number>>({});
  /** Bots working in each thread, by thread id, from every machine's events. */
  const [busy, setBusy] = useState<Record<string, readonly string[]>>({});
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  /** Each thread's messages waiting for a bot to finish, as on the desktop. They live on the phone while the app is open. */
  const queues = useRef(new Map<string, ParticipantQueues>());
  const [queued, setQueued] = useState<Record<string, { items: ParticipantMessage[]; paused: string[]; lost: boolean }>>({});
  /** What each queued message was typed as, by thread and text, so one that can't be sent goes back in the box with its files and quotes.
   *  `inBox` while Send is still waiting on it: the box keeps it until the machine has it or it is queued. */
  const queuedDrafts = useRef(new Map<string, QueuedDraft>());
  /** The queued message whose Steer now is asking first. */
  const [steerAsk, setSteerAsk] = useState<number | null>(null);
  /** Files still being read into a draft; Send waits for them. */
  const [reading, setReading] = useState(0);
  const readingRef = useRef(0);
  /** A sent draft's id → the thread it became, so a file that finishes reading late follows it. */
  const movedRef = useRef<Record<string, string>>({});
  const endRef = useRef<HTMLDivElement>(null);
  /** The open thread as last drawn, for names inside event handlers. */
  const roomRef = useRef<Room | null>(null);
  roomRef.current = room;
  const machineKey = connectionKey(machines);

  useEffect(() => {
    try { localStorage.setItem(machinesKey(), saveMachines(machines)); } catch { /* the list lasts for this session */ }
  }, [machines]);

  useEffect(() => {
    const text = Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, draft.text]));
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(text)); } catch { /* navigation within the page still keeps it */ }
  }, [drafts]);

  useEffect(() => {
    const linkTo = (machine: Machine): Connect => {
      if (!isPaired(machine)) return webSocketConnect(machine.url);
      if (!plugin) return () => Promise.reject(new FinalError(`${machine.name} was paired by QR code. Open it from the Apex Deck iPhone app.`));
      const target = () => {
        const saved = machinesRef.current.find((item) => item.id === machine.id);
        return saved && isPaired(saved) ? saved : machine;
      };
      const dial = irohConnect(target, plugin, (route) => setRoutes((all) => all[machine.id] === route ? all : { ...all, [machine.id]: route }));
      return () => whenAutomatic(ready, dial);
    };
    const opened = machines.map((machine) => openPhoneHost(
      machine,
      linkTo(machine),
      phoneShell({ machineName: machine.name, openExternal: (url) => window.open(url, "_blank", "noopener") }),
      (welcome) => {
        if (!isPaired(machine)) return;
        setMachines((list) => list.map((item) => item.id === machine.id && isPaired(item) ? withHints(item, welcome.addrs) : item));
      },
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
        setBusy((all) => { const now = all[id] ?? []; const next = busyAfter(now, event); return next === now ? all : { ...all, [id]: next }; });
        const queue = queues.current.get(id);
        if (queue) queueHears(queue, event);
        if (event.type === "approval_requested") setWaiting((all) => ({ ...all, [id]: [...(all[id] ?? []).filter((request) => request !== event.request), event.request] }));
        if (event.type === "approval_resolved") setWaiting((all) => ({ ...all, [id]: (all[id] ?? []).filter((request) => request !== event.request) }));
      }).then((stop) => { if (live) stops.push(stop); else stop(); }).catch(() => {});
    });
    return () => { live = false; stops.forEach((stop) => stop()); };
  }, [hosts]);

  // Every paired machine's Library, whether or not its machine is online; PhoneLibrary shows each one's status.
  const libraryMachines = useMemo<PhoneLibraryMachine[]>(() => hosts.map((host) => ({
    id: host.machine.id, name: host.machine.name, backend: host.backend, connection: host.connection, access: host.access,
  })), [hosts]);

  const links: LinkView[] = hosts.map((host) => {
    const { status, helper, build } = host.connection.get();
    const mismatch = status.kind === "connected" ? buildNotice(host.machine.name, __APP_BUILD__, build) ?? helperNotice(host.machine.name, __APP_VERSION__, helper) : null;
    return {
      id: host.machine.id, name: host.machine.name, kind: host.machine.kind, status: toLink(status),
      ...(status.kind === "failed" ? { problem: refusalLine(host.machine.name, status.reason) } : {}),
      ...(mismatch ? { mismatch } : {}),
    };
  });
  const mac = links.find((link) => link.kind === "mac");
  const macHost = hosts.find((host) => host.machine.kind === "mac") ?? null;
  /** A thread is saved on the Mac and runs on its machine; starting one needs Full on both. */
  const newAllowed = canSeeNewThread(macHost?.access());
  const canStartOn = (hostId: string) => newAllowed && canSeeNewThread(hosts.find((host) => host.machine.id === hostId)?.access());
  const macOnline = mac?.status === "online";
  const linkOf = (id: string) => links.find((link) => link.id === id) ?? null;
  const downWords = (id: string, name: string) => { const link = linkOf(id); return link ? downLine(link) : `Connecting to ${name}`; };
  const linkOfPane = (pane: Pane & { hostId?: string }) => { const workspace = (session?.workspaces ?? []).find((item) => item.id === pane.workspaceId); return workspace ? linkOf(pane.hostId ?? workspaceHost(workspace)) : null; };
  /** Where a bot is working, for Agents. A turn on a machine that dropped is cut off, not still going. */
  const botDoing = (id: string): { working: string | null; cutOff: string | null } => {
    const turns = (session?.panes ?? []).filter((pane) => !pane.archived && busy[pane.id]?.includes(id));
    const live = turns.find((pane) => linkOfPane(pane)?.status === "online");
    if (live) return { working: live.title, cutOff: null };
    const lost = turns[0];
    return { working: null, cutOff: lost ? `Lost ${linkOfPane(lost)?.name ?? "its machine"} while working in ${lost.title}` : null };
  };

  useEffect(() => {
    if (!macHost || !macOnline) return;
    let live = true;
    const eventVersion = sessionEventVersion.current;
    macHost.backend.sessionLoad().then((loaded) => {
      if (!live || !loaded || loaded.version !== 1) return;
      const next = sessionEventVersion.current === eventVersion
        ? loaded
        : sessionRef.current ?? pendingSessionEvents.current.reduce(
          (current, remote) => mergePhoneSessionChange(current, remote, { tag: phoneSaveTag.current, seq: phoneSaveSeq.current }),
          loaded,
        );
      pendingSessionEvents.current = [];
      sessionRef.current = next;
      setSession(next);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch { /* the list still shows from memory */ }
    }).catch(() => {});
    return () => { live = false; };
  }, [macHost, macOnline]);

  // Thread/project changes from the Mac and other phones update this phone's registry.
  // Machine pairing and presentation preferences remain in their phone-local stores.
  useEffect(() => {
    if (!macHost || !macOnline || !macHost.backend.onSessionChanged) return;
    let live = true;
    let stop = () => {};
    macHost.backend.onSessionChanged((remote) => {
      if (!live) return;
      const current = sessionRef.current;
      if (!current) { sessionEventVersion.current++; pendingSessionEvents.current.push(remote); return; }
      const next = mergePhoneSessionChange(current, remote, { tag: phoneSaveTag.current, seq: phoneSaveSeq.current });
      if (next === current) return;
      sessionEventVersion.current++;
      sessionRef.current = next;
      setSession(next);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch { /* the list still updates in memory */ }
    }).then((unlisten) => { if (live) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { live = false; stop(); };
  }, [macHost, macOnline]);

  // A machine that comes back may have finished, or started, turns while it was away:
  // ask it again for every thread the phone last saw working there.
  const onlineKey = links.filter((link) => link.status === "online").map((link) => link.id).join("\n");
  // A machine that drops holds its threads' queued messages until the person resumes them.
  useEffect(() => { queues.current.forEach((queue) => queue.availabilityChanged()); }, [onlineKey]);
  const wasOnline = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(onlineKey ? onlineKey.split("\n") : []);
    const back = [...now].filter((id) => !wasOnline.current.has(id));
    wasOnline.current = now;
    let live = true;
    for (const hostId of back) {
      const host = phoneHost(hostId);
      if (!host?.backend.roomState) continue;
      const there = (session?.panes ?? []).filter((pane) => ((busy[pane.id]?.length ?? 0) > 0 || (queued[pane.id]?.items.length ?? 0) > 0) && linkOfPane(pane)?.id === hostId);
      for (const pane of there) {
        const settle = (active: readonly string[]) => {
          if (!live) return;
          setBusy((all) => ({ ...all, [pane.id]: active }));
          const queue = queues.current.get(pane.id);
          if (queue) queueSync(queue, active);
        };
        host.backend.roomState(pane.id)
          .then((state) => settle(state.active))
          // A thread the machine no longer has open has nothing running.
          .catch(() => settle([]));
      }
    }
    return () => { live = false; };
    // Runs when the set of online machines changes, with the busy list as it stood then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineKey]);

  const workspaces = session?.workspaces ?? [];
  const phoneHost = (id: string) => hosts.find((host) => host.machine.id === id) ?? null;
  const assistantProjects = useMemo(() => workspaces.filter((workspace) => !workspace.hidden).map((workspace) => {
    const hostId = workspaceHost(workspace);
    const host = hosts.find((item) => item.machine.id === hostId);
    return { workspace, link: linkOf(hostId), allowed: canSeeNewThread(host?.access()) };
  }), [workspaces, hosts, tick]);
  const visibleAssistantRegistry = useMemo(() => currentAssistantRegistry(assistantRegistry,
    Object.fromEntries(Object.entries(assistantOwners).filter(([workspaceId, owner]) => {
      const project = assistantProjects.find((item) => item.workspace.id === workspaceId);
      return !!project?.allowed && project.workspace.path === owner.cwd && workspaceHost(project.workspace) === owner.hostId;
    })),
  ), [assistantRegistry, assistantOwners, assistantProjects]);
  const savedPanes = session?.panes;
  const humanPanes = useMemo(() => (savedPanes ?? []).map((pane) => (seen[pane.id] ?? 0) > (pane.activeAt ?? 0) ? { ...pane, activeAt: seen[pane.id] } : pane), [savedPanes, seen]);
  const panes = useMemo(() => mergeAssistantPanes(humanPanes, visibleAssistantRegistry), [humanPanes, visibleAssistantRegistry]);
  const sections = useMemo(() => sidebarSections(panes, workspaces, "threads", new Set()), [panes, workspaces]);
  const openPane = panes.find((pane) => pane.id === openId) ?? null;
  const pendingWorkspace = workspaces.find((workspace) => workspace.id === pending?.workspaceId) ?? null;
  const viewingPending = pending !== null && openId === pending.id;
  const openWorkspace = viewingPending ? pendingWorkspace : workspaces.find((workspace) => workspace.id === openPane?.workspaceId) ?? null;
  const hostOf = (workspace: Workspace | null) => links.find((link) => link.id === (workspace ? workspaceHost(workspace) : "")) ?? null;
  const openHostId = openPane?.hostId ?? (openWorkspace ? workspaceHost(openWorkspace) : "");
  const openPath = openPane?.executionPath ?? openWorkspace?.path ?? "";
  const openLink = linkOf(openHostId) ?? hostOf(openWorkspace);
  const assistantWorkspace = workspaces.find((workspace) => workspace.id === assistantWorkspaceId) ?? null;
  // One collection discovers all paired machines; notifications select their exact durable owner.
  const personal = usePersonalAssistant({
    hosts: hosts.map((host) => ({ id: host.machine.id, name: host.machine.name, remote: true })),
    hostBackend: (id) => { const host = phoneHost(id); if (!host) throw new Error("That machine isn't paired with this phone."); return host.backend; },
    offlineHost: (id) => linkOf(id)?.status !== "online",
    open: tab === "agents" || personalOpen, device: "phone", onOpen: () => setPersonalOpen(true),
  });
  const assistantWorkspaceHost = assistantWorkspace ? phoneHost(workspaceHost(assistantWorkspace)) : null;

  useEffect(() => {
    let live = true;
    const versions = new Map<string, number>();
    const eligible = assistantProjects.filter((project) => project.allowed && project.link?.status === "online");
    const refresh = async (project: typeof assistantProjects[number]) => {
      const host = hosts.find((item) => item.machine.id === workspaceHost(project.workspace));
      if (!host || !project.allowed || project.link?.status !== "online") return;
      const version = (versions.get(project.workspace.id) ?? 0) + 1;
      versions.set(project.workspace.id, version);
      try {
        const monitor = await host.backend.call<ProjectMonitor | null>("monitor_get", { workspaceId: project.workspace.id });
        if (!live || versions.get(project.workspace.id) !== version) return;
        if (monitor && (monitor.workspaceId !== project.workspace.id || monitor.cwd !== project.workspace.path || monitor.hostId !== host.machine.id))
          throw new Error("The assistant returned an assignment for a different project folder or machine.");
        if (!monitor) {
          setAssistantOwners((all) => {
            if (!(project.workspace.id in all)) return all;
            const { [project.workspace.id]: _old, ...rest } = all;
            return rest;
          });
          setAssistantRegistryErrors((all) => { const { [project.workspace.id]: _old, ...rest } = all; return rest; });
          return;
        }
        const owner: AssistantTaskOwner = { workspaceId: monitor.workspaceId, cwd: monitor.cwd, hostId: monitor.hostId, conversationId: monitor.conversationId };
        setAssistantOwners((all) => JSON.stringify(all[project.workspace.id]) === JSON.stringify(owner)
          ? all : { ...all, [project.workspace.id]: owner });
        const snapshot = await host.backend.call<AssistantTaskSnapshot>("assistant_tasks_list", { owner });
        if (!live || versions.get(project.workspace.id) !== version) return;
        setAssistantRegistry((state) => reduceAssistantSnapshot(state, owner, snapshot));
        setAssistantRegistryErrors((all) => { const { [project.workspace.id]: _old, ...rest } = all; return rest; });
      } catch (error) {
        if (live && versions.get(project.workspace.id) === version) setAssistantRegistryErrors((all) => ({ ...all, [project.workspace.id]: words(error) }));
      }
    };
    eligible.forEach((project) => { void refresh(project); });
    const stops: (() => void)[] = [];
    for (const host of hosts) {
      const projects = eligible.filter((project) => workspaceHost(project.workspace) === host.machine.id);
      if (!projects.length || !host.backend.onAssistantTasksChanged) continue;
      void host.backend.onAssistantTasksChanged((payload) => {
        if (!live) return;
        const changed = payload as { workspaceId?: string } | null;
        for (const project of projects) if (!changed?.workspaceId || changed.workspaceId === project.workspace.id) void refresh(project);
      }).then((stop) => { if (live) stops.push(stop); else stop(); }).catch(() => {});
    }
    const timer = window.setInterval(() => eligible.forEach((project) => { void refresh(project); }), 30_000);
    return () => { live = false; clearInterval(timer); stops.forEach((stop) => stop()); };
  }, [assistantProjects, hosts]);

  const draftFor = (id: string) => drafts[id] ?? emptyDraft();
  const setDraft = (id: string, next: Draft) => setDrafts((all) => ({ ...all, [id]: next }));

  // The queue outlives renders, so it reads the machines and who is working as they are now.
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const voiceRoomsRef = useRef({ panes, workspaces });
  voiceRoomsRef.current = { panes, workspaces };
  const participantsRef = useRef(new Map<string, {id:string;display_name:string;media?:unknown}[]>());
  const screenRef = useRef({hostId:openHostId,roomId:openPane?.id ?? '',shown:tab==='threads' && openId!==null});
  screenRef.current={hostId:openHostId,roomId:openPane?.id ?? '',shown:tab==='threads' && openId!==null};
  if (room && openHostId) participantsRef.current.set(JSON.stringify([openHostId,room.id]),room.configs.map(p=>({id:p.id,display_name:p.display_name,media:p.media})));
  const phoneVoiceRef = useRef<PhoneVoice | null>(null);
  if (!phoneVoiceRef.current) phoneVoiceRef.current=createPhoneVoice({
    host:id=> {const h=hostsRef.current.find(h=>h.machine.id===id); if(!h)return null;return {name:h.machine.name,backend:h.backend,voice:h.voice,canCall:()=>h.supports('voice_server_v1')&&h.access()?.tier!=='read_only',whenConnected:ms=>new Promise<void>((resolve,reject)=>{if(h.connection.get().status.kind==='connected'){resolve();return;}const timer=setTimeout(()=>{off();reject(Error(`Can't reach ${h.machine.name} right now.`));},ms);const off=h.connection.subscribe(()=>{if(h.connection.get().status.kind==='connected'){clearTimeout(timer);off();resolve();}});})};},
    queue:(host,room)=>queueFor(room,host),participants:(host,room)=>participantsRef.current.get(JSON.stringify([host,room]))??[],onScreen:(host,room)=>screenRef.current.shown&&screenRef.current.hostId===host&&screenRef.current.roomId===room,storage:localStorage,keepAwake,
    roomTitle:(host,room)=>{
      const current=voiceRoomsRef.current;
      const pane=current.panes.find(p=>p.id===room);
      const project=current.workspaces.find(w=>w.id===pane?.workspaceId);
      return pane&&(pane.hostId??(project?workspaceHost(project):''))===host?pane.title:undefined;
    },
  });
  const phoneVoice=phoneVoiceRef.current;
  useEffect(()=>{const left=()=>{if(document.hidden)phoneVoice.leftScreen();};document.addEventListener('visibilitychange',left);return()=>{document.removeEventListener('visibilitychange',left);phoneVoice.leftScreen();};},[phoneVoice]);
  useEffect(()=>{if(openPane&&openHostId)phoneVoice.threadOpened(openHostId,openPane.id);},[openPane?.id,openHostId]);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** Put a queued message back in its thread's box, with the files and quotes it was sent with. */
  function takeBack(paneId: string, text: string) {
    const key = `${paneId}\u0000${text}`;
    const sent = queuedDrafts.current.get(key);
    const back = sent?.draft ?? { text: splitTldr(text).text, files: [] };
    queuedDrafts.current.delete(key);
    setDrafts((all) => ({ ...all, [paneId]: giveBack(all[paneId] ?? emptyDraft(), back) }));
    if (sent?.quotes.length) setQuotes((all) => ({ ...all, [paneId]: quotesBack(all[paneId] ?? [], sent.quotes) }));
  }
  /** A thread's queue, made the first time it is needed. A thread never changes machines once it has started. */
  function queueFor(paneId: string, hostId: string): ParticipantQueues {
    const made = queues.current.get(paneId);
    if (made) return made;
    const host = () => hostsRef.current.find((item) => item.machine.id === hostId) ?? null;
    const backend = () => {
      const found = host();
      if (!found) throw new Error("This thread's machine isn't paired with this phone.");
      return found.backend;
    };
    const queue: ParticipantQueues = new ParticipantQueues(
      async (text) => {
        const shown = roomRef.current;
        const sticky = shown?.id === paneId ? queuedSticky(text, shown.participants, shown.policy, queue.items) : null;
        return sticky ?? backend().roomTargets(paneId, text);
      },
      async (text, to, kind, hops, voice) => {
        // Retry asks the bot again on the chat as it is, posting nothing, as on the desktop.
        if (kind === "turn") { await backend().roomTurn(paneId, to, hops ?? null); return; }
        const key = `${paneId}\u0000${text}`;
        try { await postFromPhone(backend(), paneId, text, to, voice); }
        catch (error) {
          if (voice) { phoneVoice.failed(hostId,paneId,to[0],voice.requestId,error); throw error; }
          const sent = queuedDrafts.current.get(key);
          // The queue holds these bots after a failure, as on the desktop. When the message is in the box again,
          // sending it again should just send, so let go of any bot with nothing else waiting once the queue has paused it.
          if (sent) setTimeout(() => { for (const bot of to) if (!queue.items.some((item) => item.to.includes(bot))) queue.resume(bot); }, 0);
          // Still in the box when Send is waiting on it; a message that had been queued goes back into it.
          if (sent?.inBox) { sent.failed = true; throw new Error(`${words(error)}. Your message is still in the box.`); }
          if (sent) { takeBack(paneId, text); throw new Error(`${words(error)}. Your message is back in the box.`); }
          throw error;
        }
        queuedDrafts.current.delete(key);
      },
      (id) => backend().roomStop(paneId, id),
      (items) => setQueued((all) => ({ ...all, [paneId]: { items, paused: [...queue.paused], lost: queue.connectionPaused } })),
      (error) => setNotice(words(error)),
      () => { const found = host(); return queues.current.get(paneId) === queue && found !== null && toLink(found.connection.get().status) === "online"; },
      false, // Phone restores the complete draft itself on dispatch failure.
    );
    for (const id of busyRef.current[paneId] ?? []) queue.started(id);
    queues.current.set(paneId, queue);
    return queue;
  }

  const sessionEdits = useRef(serialEdits());
  function saveSession(change: (current: AppSession) => AppSession | Promise<AppSession>) {
    return sessionEdits.current(async () => {
      if (!macHost) throw new Error(mac ? downLine(mac) : "Pair this phone with your Mac before saving a thread.");
      const fresh = await macHost.backend.sessionLoad();
      if (!fresh) throw new Error("The Mac has no saved threads.");
      const next = { ...await change(fresh), savedBy: `${phoneSaveTag.current}:${++phoneSaveSeq.current}` };
      await macHost.backend.sessionSave(next);
      sessionRef.current = next;
      setSession(next);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch { /* saved on the Mac */ }
      return next;
    });
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
    if (!canStartOn(workspaceHost(workspace))) { setNotice("Starting a thread needs Full access on its machine. Change this phone's level in that machine's Settings → Phones."); return; }
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

  // Saved steps per finished reply: the index says which replies have them; a reply's own steps load when its line is opened.
  // Retry and Revert cut a thread back, so they forget the steps from there and look again.
  const [savedSteps, setSavedSteps] = useState<SavedStepsFor | null>(null);
  const loadedSteps = useRef(new Map<number, import("../types").ReplySteps>());
  const refreshSteps = useRef<() => void>(() => {});
  const openPaneRef = useRef<string | null>(null);
  openPaneRef.current = openPane?.id ?? null;
  useEffect(() => {
    if (!openPane || !openWorkspace) { if (!viewingPending) setRoom(null); return; }
    const host = phoneHost(openHostId);
    // Offline keeps what is already on screen under the banner; it reloads when the machine is back.
    // Bots that were mid-reply are cut off: their turn shows as interrupted, not still going.
    if (!host || toLink(host.connection.get().status) !== "online") {
      const shown = roomRef.current;
      if (shown?.id === openPane.id && Object.keys(shown.working).length > 0) {
        const after = shown.messages[shown.messages.length - 1]?.seq ?? 0;
        setCuts((all) => ({ ...all, [openPane.id]: cutOff(all[openPane.id] ?? {}, shown.working, after) }));
      }
      setRoom((current) => current?.id !== openPane.id ? null : Object.keys(current.working).length === 0 ? current : { ...current, working: {} });
      return;
    }
    let live = true;
    let stop = () => {};
    const paneId = openPane.id;
    loadedSteps.current.clear();
    const stepsLoader = createStepsIndexLoader(
      () => host.backend.roomSteps(paneId, null),
      (index) => {
        if (!live) return;
        for (const seq of [...loadedSteps.current.keys()]) if (!index?.replies[String(seq)]) loadedSteps.current.delete(seq);
        setSavedSteps({ id: paneId, index });
      },
    );
    refreshSteps.current = () => { void stepsLoader.refresh(); };
    const settingsHeard = new Map<string, ParticipantConfig>();
    let rosterHeard: ParticipantConfig[] | null = null;
    const applyState = (state: RoomState) => {
      if (!live) return;
      void stepsLoader.refresh();
      setWaiting((all) => ({ ...all, [openPane.id]: state.approvals.map((card) => card.request) }));
      setBusy((all) => ({ ...all, [openPane.id]: state.active }));
      const queue = queues.current.get(openPane.id);
      if (queue) queueSync(queue, state.active);
      setCuts((all) => all[openPane.id] ? { ...all, [openPane.id]: resumeCut(all[openPane.id], state.active, state.snapshot.transcript) } : all);
      const configs = (rosterHeard ?? state.snapshot.participants).map(config => settingsHeard.get(config.id) ?? config);
      setRoom({
        id: openPane.id,
        messages: state.snapshot.transcript,
        approvals: state.approvals,
        participants: configs.map(toPerson),
        asks: restoreQuestions({}, openPane.id, state, Date.now())[openPane.id] ?? NO_ASKS,
        plan: Boolean(state.plan ?? state.snapshot.plan),
        policy: state.snapshot.options.policy,
        working: workingFrom(state.active, Date.now()),
        configs,
        fill: {},
        plans: {},
        credits: {},
        used: state.snapshot.usage ?? {},
        pins: state.snapshot.pins ?? [],
      });
    };
    const applyEvent = (event: RoomEvent) => {
      if (!live) return;
      const id = openPane.id;
      // The host saves a reply's steps just after it announces the reply, so look again when the bot or the thread goes idle.
      if (event.type === "participant_idle" || event.type === "idle") void stepsLoader.refresh();
      if (event.type === "participants_changed") { rosterHeard = event.participants; settingsHeard.clear(); }
      if (event.type === "participants_changed") setRoom((current) => current && current.id === id ? { ...current, configs: event.participants, participants: event.participants.map(toPerson) } : current);
      if (event.type === "participant_changed") settingsHeard.set(event.participant.id, event.participant);
      if (event.type === "participant_changed") setRoom((current) => current && current.id === id ? { ...current, configs: current.configs.map((config) => config.id === event.participant.id ? event.participant : config), participants: current.participants.map((person) => person.id === event.participant.id ? toPerson(event.participant) : person) } : current);
      if (event.type === "message_added") setRoom((current) => current && current.id === id && !current.messages.some((message) => message.seq === event.message.seq) ? { ...current, messages: [...current.messages, event.message] } : current);
      if (event.type === "approval_requested") setRoom((current) => current && current.id === id ? { ...current, approvals: [...current.approvals.filter((card) => card.request !== event.request), { id: event.id, request: event.request, action: event.action }] } : current);
      if (event.type === "approval_resolved") setRoom((current) => current && current.id === id ? { ...current, approvals: current.approvals.filter((card) => card.request !== event.request) } : current);
      if (event.type === "plan_changed") setRoom((current) => current && current.id === id ? { ...current, plan: event.on } : current);
      if (event.type === "context_usage") setRoom((current) => current && current.id === id ? { ...current, fill: { ...current.fill, [event.id]: { used: event.used_tokens, window: event.window_tokens } } } : current);
      if (event.type === "usage") setRoom((current) => {
        if (!current || current.id !== id) return current;
        const before = current.used[event.id] ?? { input: 0, output: 0, turns: 0 };
        return { ...current, used: { ...current.used, [event.id]: { input: before.input + (event.input_tokens ?? 0), output: before.output + (event.output_tokens ?? 0), turns: before.turns + 1 } } };
      });
      if (event.type === "plan_usage") setRoom((current) => current && current.id === id ? {
        ...current,
        plans: { ...current.plans, [planKey(event.provider, event.model)]: mergePlan(current.plans[planKey(event.provider, event.model)], event.windows, event.partial) },
        credits: event.reset_credits ? { ...current.credits, [event.provider]: event.reset_credits } : current.credits,
      } : current);
      if (event.type === "failed") setNotice(`${roomRef.current?.participants.find((person) => person.id === event.id)?.display_name ?? event.id} couldn't reply: ${event.error}`);
      setCuts((all) => { const now = all[id]; const next = now && applyCutEvent(now, event); return !now || next === now ? all : { ...all, [id]: next }; });
      setRoom((current) => {
        if (!current || current.id !== id) return current;
        const asks = applyQuestionEvent({ [id]: current.asks }, id, event, Date.now())[id] ?? NO_ASKS;
        const working = applyTurnEvent(current.working, event, Date.now());
        return asks === current.asks && working === current.working ? current : { ...current, asks, working };
      });
    };
    const recovery = createRoomRecovery<RoomState, RoomEvent>({
      load: () => loadRoomState(host.backend, openPane.id, [], NEW_THREAD, openPath),
      apply: applyState,
      event: applyEvent,
      represented: representedRoomEvent,
      fail: (error) => { if (live) setNotice(words(error)); },
    });
    // Install the listener first. Events received before or during the snapshot are
    // buffered and replayed only when the snapshot does not already represent them.
    host.backend.onRoomEvent((id, event) => {
      if (!live || id !== openPane.id) return;
      if (!recovery.capture(event)) applyEvent(event);
    }).then((unlisten) => {
      if (!live) { unlisten(); return; }
      stop = unlisten;
      void recovery.refresh();
    }).catch((error) => { if (live) setNotice(words(error)); });
    return () => { live = false; recovery.dispose(); stop(); refreshSteps.current = () => {}; };
    // Reloading follows the open thread and that machine's connection, not every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPane?.id, openWorkspace?.id, openLink?.status, openHostId, openPath]);

  // Who the message as typed goes to: its @names, or the bots named last when it has none.
  // Asked again as the draft changes and after each message, since a send can change it.
  const [answerers, setAnswerers] = useState<{ paneId: string; ids: string[] } | null>(null);
  const quotedNow = openId ? quotes[openId] ?? [] : [];
  const typed = openId ? (quotedNow.length ? outgoingText(draftFor(openId).text, quotedNow, room?.participants ?? []) : draftFor(openId).text) : "";
  useEffect(() => {
    if (!room || !openWorkspace) return;
    const host = phoneHost(openHostId);
    if (!host || toLink(host.connection.get().status) !== "online") return;
    // An untagged message behind a queued tag goes where that tag goes, before the thread has heard it.
    const sticky = queuedSticky(typed, room.participants, room.policy, queued[room.id]?.items ?? []);
    if (sticky) { setAnswerers({ paneId: room.id, ids: sticky }); return; }
    let live = true;
    // A short wait so typing doesn't ask the machine on every key; a slower answer for older text is ignored.
    const ask = window.setTimeout(() => {
      host.backend.roomTargets(room.id, typed).then((ids) => { if (live) setAnswerers({ paneId: room.id, ids }); }).catch(() => {});
    }, typed ? 150 : 0);
    return () => { live = false; window.clearTimeout(ask); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id, room?.messages.length, openLink?.status, openHostId, typed, queued[room?.id ?? ""]?.items]);

  // A bot's details belong to the thread they were opened in.
  useEffect(() => { setBotSheet(null); setSteerAsk(null); setGoingBack(null); }, [openId]);
  // Steer now stops asking once its message has gone, been steered, or been taken back.
  const queuedIds = (openId ? queued[openId]?.items ?? [] : []).map((item) => item.id).join(",");
  useEffect(() => { setSteerAsk((asking) => asking !== null && queuedIds.split(",").includes(String(asking)) ? asking : null); }, [queuedIds]);

  // Follow the newest message and a reply as it streams in, unless the person scrolled up to read.
  const stuckRef = useRef(true);
  const shownRef = useRef<string | null>(null);
  const streamed = room ? Object.values(room.working).reduce((sum, turn) => sum + turn.text.length + turn.steps.length + turn.work.steps.length + turn.work.todo.length + 1, 0) : 0;
  useEffect(() => {
    if (shownRef.current !== openId) stuckRef.current = true;
    shownRef.current = openId;
    if (stuckRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [room?.messages.length, room?.approvals.length, openId, streamed]);

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
    stuckRef.current = true;
    setSending(true);
    try {
      const starter = (session?.profiles ?? [])[0] ?? null;
      let pane = openPane;
      const loaded = room && pane && room.id === pane.id ? room : null;
      let participants = loaded ? loaded.participants : [];
      let transcriptLength = loaded ? loaded.messages.length : 0;
      if (viewingPending && pending) {
        if (!starter) { setNotice("This phone has no saved bot to start a thread with. Add one on the Mac first."); return; }
        const made = pendingRoomIds.current[pending.id] ?? { id: `pane-${Date.now().toString(36)}`, workspaceId: pending.workspaceId, kind: "chat" as const, title: "New thread" };
        pendingRoomIds.current[pending.id] = made;
        // Open the room before saving or showing it, so a second open keeps this bot.
        const state = await loadRoomState(host.backend, made.id, [starter], NEW_THREAD, openPath);
        await setPlanBeforeContinuation(
          made.id,
          pendingDraftPlans[pending.id] ?? false,
          (roomId, enabled) => host.backend.roomSetPlan(roomId, enabled),
          () => saveSession((current) => ({ ...current, panes: [...current.panes, made] })).then(() => undefined),
        );
        pane = made;
        participants = state.snapshot.participants.map(toPerson);
        transcriptLength = state.snapshot.transcript.length;
        movedRef.current[pending.id] = made.id;
        setDrafts((all) => { const next = { ...all, [made.id]: all[pending.id] ?? draft }; delete next[pending.id]; return next; });
        if (tldrOf(pending.id)) { setTldr(made.id, true); setTldr(pending.id, false); }
        setPending(null);
        delete pendingRoomIds.current[pending.id];
        setPendingDraftPlans((all) => { const next = { ...all }; delete next[pending.id]; return next; });
        setOpenId(made.id);
      } else if (pane && room?.id !== pane.id) {
        const state = await loadRoomState(host.backend, pane.id, [], NEW_THREAD, openPath);
        participants = state.snapshot.participants.map(toPerson);
        transcriptLength = state.snapshot.transcript.length;
      }
      if (!pane) return;
      const sentPane = pane;
      if (participants.length === 0) { setNotice("This thread has no bots yet, so nothing would answer. Add one from Bots in the thread’s ⋯ menu."); return; }
      const paths: string[] = [];
      for (const file of draft.files) paths.push(await host.backend.saveAttachment(sentPane.id, file.name, file.bytes));
      // Quotes go under the text, led by the bot they're handed to, as on the desktop.
      const sentQuotes = quotes[id] ?? [];
      // TL;DR asks every bot for a short answer; the line rides on the message but never shows in the chat.
      const body = withTldr(withAttachments(outgoingText(draft.text, sentQuotes, participants), paths), tldrOf(id));
      // The room picks who answers, as on the desktop: whoever is @named, or whoever was named last.
      // A bot still working gets it once it finishes; until then it waits on the phone as "Queued".
      // This resolves once the machine has it, or once it is queued; until then the box keeps it.
      const key = `${sentPane.id}\u0000${body}`;
      const entry: QueuedDraft = { draft, quotes: sentQuotes, inBox: true };
      queuedDrafts.current.set(key, entry);
      try { await queueFor(sentPane.id, host.machine.id).send(body); }
      catch (error) { queuedDrafts.current.delete(key); throw error; }
      finally { entry.inBox = false; }
      // Refused: it never left the box, and the notice says so.
      if (entry.failed) { queuedDrafts.current.delete(key); return; }
      // Clear only what was sent; anything typed, attached or quoted while it was sending stays.
      setDrafts((all) => {
        const now = all[sentPane.id] ?? emptyDraft();
        return { ...all, [sentPane.id]: { text: now.text === draft.text ? "" : now.text, files: now.files.filter((file) => !draft.files.includes(file)) } };
      });
      if (sentQuotes.length) setQuotes((all) => ({ ...all, [sentPane.id]: (all[sentPane.id] ?? []).filter((quote) => !sentQuotes.includes(quote)) }));
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
    // Queued behind that bot's reply if it is still working, as on the desktop.
    try { await queueFor(openPane.id, openLink.id).sendTo(step.prompt, [by]); }
    catch (error) { setNotice(words(error)); }
  }

  /** Stop one bot's turn; the machine then sends its ending like any other. What was queued for it waits for Resume. */
  async function stopBot(id: string) {
    if (!openPane || !openLink) return;
    const host = phoneHost(openLink.id);
    if (!host || openLink.status !== "online") { setNotice(downLine(openLink)); return; }
    await queueFor(openPane.id, openLink.id).halt(id);
  }

  /** Send a queued message now: its bots stop mid-turn, and it goes as soon as they have. */
  function steerNow(paneId: string, item: number) {
    setSteerAsk(null);
    const queue = queues.current.get(paneId);
    if (queue) queue.steerQueued(item).catch((error) => setNotice(words(error)));
  }

  /** Take a queued message out of the queue and back into the box to change it. */
  function unqueue(paneId: string, item: number) {
    const queue = queues.current.get(paneId);
    const found = queue?.items.find((entry) => entry.id === item);
    if (!queue || !found) return;
    queue.remove(item);
    takeBack(paneId, found.text);
  }

  /** Ask the thread's machine which models a bot's tool offers, once per machine and tool. */
  useEffect(() => {
    if (!botSheet || !room || !openLink || openLink.status !== "online") return;
    const backend = room.configs.find((config) => config.id === botSheet)?.backend;
    const host = phoneHost(openLink.id)?.backend;
    let live = true;
    if (backend?.kind === "open_ai_compatible") {
      // Asked through the bot, so the machine uses the bot's own address and key. The balance is read on each open.
      const key = apiAccountKey(openLink.id, backend);
      const keep = (patch: { models?: ApiModel[]; balance?: number | null }) => { if (live) setApiOffered((all) => ({ ...all, [key]: { ...all[key], ...patch } })); };
      if (!apiOffered[key]?.models) host?.roomBotModels?.(room.id, botSheet).then((models) => keep({ models })).catch(() => {});
      host?.roomBotBalance?.(room.id, botSheet).then((balance) => keep({ balance })).catch(() => {});
      return () => { live = false; };
    }
    if (backend?.kind !== "agent") return;
    const key = `${openLink.id}:${backend.tool}`;
    if (offered[key]) return;
    host?.agentModels(backend.tool).then((list) => { if (live) setOffered((all) => ({ ...all, [key]: list })); }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botSheet, room?.id, openLink?.id, openLink?.status]);

  /**
   * Change a bot's model or reasoning from the phone. Each write reads the bot as its machine has it now
   * and lays only the phone's changes over it, so a change made on the Mac in the meantime isn't undone.
   */
  function saveTurn(paneId: string, hostId: string, botId: string) {
    const key = `${hostId}:${paneId}:${botId}`;
    let save = turnSaves.current.get(key);
    if (!save) {
      save = latestSaveQueue<{ change: TurnChange; reported: ModelChoice[]; apiModels: ApiModel[] }>(async ({ change, reported, apiModels }) => {
        const host = phoneHost(hostId);
        const link = linkOf(hostId);
        if (!host || !link || link.status !== "online") throw new Error(link ? `${downLine(link)}. Nothing changed.` : "That machine isn't paired with this phone.");
        const now = await host.backend.roomCreate(paneId, [], { policy: "mention", max_bot_hops: 0 }, "");
        const saved = now.participants.find((config) => config.id === botId);
        if (!saved) throw new Error("This bot is no longer in the thread.");
        const next = withPhoneChange(saved, change, reported, apiModels);
        const result = await host.backend.roomUpdateParticipant(paneId, next, saved);
        const actual = result || (await host.backend.roomCreate(paneId, [], { policy: "mention", max_bot_hops: 0 }, "")).participants.find(config => config.id === botId) || next;
        if (!result) setRoom((current) => current && current.id === paneId ? { ...current, configs: current.configs.map((config) => config.id === botId ? actual : config) } : current);
      });
      turnSaves.current.set(key, save);
    }
    return save;
  }

  /** Open a sheet over the thread. Tools are asked for each time, from the thread's machine. */
  function openSheet(next: SheetKind) {
    setSheet(next);
    setQuery("");
    if (next !== "tools" || !openLink) return;
    setTools(null);
    setToolQuery("");
    const host = phoneHost(openLink.id);
    if (!openPane || !host || openLink.status !== "online") { setTools([]); return; }
    Promise.all((room?.participants ?? []).map((participant) => host.backend.listToolServers(openPane.id, participant.id).catch(() => [] as ToolServer[])))
      .then((lists) => setTools(lists.flat().filter((tool, index, all) => all.findIndex((other) => other.token === tool.token) === index)))
      .catch(() => setTools([]));
  }

  function openComposer() {
    composerDestination.current = { id: openId, workspaceId: openWorkspace?.id ?? null };
    (document.activeElement as HTMLElement | null)?.blur?.();
    setComposerOpen(true);
  }

  useEffect(() => {
    const destination = composerDestination.current;
    if (composerOpen && destination && (destination.id !== openId || destination.workspaceId !== (openWorkspace?.id ?? null))) setComposerOpen(false);
  }, [composerOpen, openId, openWorkspace?.id]);

  function startPicker() {
    // This runs from the picker button, before the native picker can suspend the page.
    pickerDraft.current = openId;
  }

  async function readAttachments(_kind: "camera" | "photos" | "files", selected: File[]) {
    const capturedId = pickerDraft.current;
    pickerDraft.current = null;
    await readCapturedFiles({
      capturedId, moved: movedRef.current, files: selected,
      makeAttachment: async (file) => ({ id: crypto.randomUUID(), name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }),
      onStart: () => { readingRef.current += 1; setReading(readingRef.current); },
      onAdd: (target, added) => setDrafts((all) => { const now = all[target] ?? emptyDraft(); return { ...all, [target]: { ...now, files: [...now.files, ...added] } }; }),
      onError: (error) => setNotice(words(error)),
      onFinish: () => { readingRef.current -= 1; setReading(readingRef.current); },
    });
  }

  async function stopPlanning() {
    if (!openPane || !openLink) return;
    try { await phoneHost(openLink.id)?.backend.roomSetPlan(openPane.id, false); }
    catch (error) { setNotice(words(error)); }
  }

  async function changeComposerPlan(on: boolean) {
    if (pending && openId === pending.id) {
      if (sendingRef.current) return;
      setPendingDraftPlans((all) => ({ ...all, [pending.id]: on }));
      return;
    }
    if (!openPane || !openLink) return;
    if (composerPlanLock.current) return;
    const roomId = openPane.id;
    const host = phoneHost(openLink.id);
    if (!host || openLink.status !== "online" || host.access()?.tier === "read_only") return;
    composerPlanLock.current = true;
    setComposerPlan({ roomId, pending: true, error: null });
    try {
      await setPlanBeforeContinuation(roomId, on, (targetRoomId, enabled) => host.backend.roomSetPlan(targetRoomId, enabled), async () => {
        setComposerPlan({ roomId, pending: false, error: null });
      });
    } catch (error) {
      setComposerPlan({ roomId, pending: false, error: words(error) });
    } finally {
      composerPlanLock.current = false;
    }
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

  /** Bring an archived thread back on the Mac, then open it here, as the Mac's Archived list does. */
  async function restoreArchived(id: string) {
    try {
      await saveSession((current) => ({ ...current, panes: unarchiveThreads(current.panes, [id]) }));
      openThread(id);
    } catch (error) {
      setNotice(words(error));
    }
  }

  /** Take a project and its threads out of the list on the Mac. Its folder on disk is never touched, and Undo brings the threads back for a few seconds. */
  async function removeProject(id: string) {
    setMenu(null);
    const made: { undo: RemovedProject | null } = { undo: null };
    try {
      await saveSession(async (current) => {
        const workspace = current.workspaces.find((item) => item.id === id);
        if (!workspace) return current;
        const hostId = workspaceHost(workspace);
        const host = phoneHost(hostId);
        if (!host || toLink(host.connection.get().status) !== "online") throw new Error("Connect the project's machine before removing it.");
        if (!canStartOn(hostId)) throw new Error("Removing a project needs Full access on its machine.");
        await stopProjectPanes(current.panes.filter((pane) => pane.workspaceId === id), host.backend, (paneId) => {
          const queue = queues.current.get(paneId);
          if (queue) {
            queues.current.delete(paneId);
            queue.availabilityChanged();
            for (const item of [...queue.items]) queue.remove(item.id);
          }
          for (const key of queuedDrafts.current.keys()) if (key.startsWith(`${paneId}\u0000`)) queuedDrafts.current.delete(key);
        });
        const removed = removeProjectFrom(current, id);
        made.undo = removed.undo;
        return removed.next;
      });
    } catch (error) {
      setNotice(words(error));
      return;
    }
    if (!made.undo) return;
    const { undo } = made;
    if (openWorkspace?.id === id) setOpenId(null);
    if (pending?.workspaceId === id) {
      setPending(null);
      setDrafts((all) => { const next = { ...all }; delete next[pending.id]; return next; });
    }
    setProjectUndo({ undo, name: undo.workspace.name });
    if (projectUndoTimer.current) clearTimeout(projectUndoTimer.current);
    projectUndoTimer.current = setTimeout(() => setProjectUndo(null), UNDO_MS);
  }

  /** Put a removed project and its threads back, for Undo. */
  async function undoRemoveProject() {
    const removed = projectUndo;
    if (!removed) return;
    if (projectUndoTimer.current) clearTimeout(projectUndoTimer.current);
    try {
      await saveSession((current) => restoreProjectTo(current, removed.undo));
      setProjectUndo((current) => current === removed ? null : current);
    } catch (error) {
      setNotice(words(error));
    }
  }

  /** Fork from one message on the same machine and project: the new thread keeps the history up to and including it. */
  async function forkFrom(source: Pane, seq: number) {
    const fromWorkspace = workspaces.find((workspace) => workspace.id === source.workspaceId);
    const host = fromWorkspace ? phoneHost(workspaceHost(fromWorkspace)) : null;
    if (!fromWorkspace || !host) { setNotice("That machine isn't paired with this phone."); return; }
    if (!mac || mac.status !== "online") { setNotice(mac ? downLine(mac) : "Pair this phone with your Mac before saving a thread."); return; }
    if (toLink(host.connection.get().status) !== "online") { setNotice(downWords(host.machine.id, host.machine.name)); return; }
    try {
      const id = `pane-${Date.now().toString(36)}`;
      const upto = forkUpto(seq);
      await host.backend.roomFork(source.id, id, upto);
      try {
        await saveSession((current) => ({ ...current, panes: [...current.panes, forkedPane(source, id, seq, host.machine.name)] }));
      } catch (error) {
        await host.backend.roomDelete(id).catch(() => {});
        throw error;
      }
      openThread(id);
    } catch (error) {
      setNotice(words(error));
    }
  }

  /** The open thread's machine when it can take a change from this phone; otherwise says why and gives null. */
  function changeHost(what: string): PhoneHost | null {
    const host = openLink ? phoneHost(openLink.id) : null;
    if (!host || !openLink) { setNotice("This thread's machine isn't paired with this phone."); return null; }
    if (openLink.status !== "online") { setNotice(downLine(openLink)); return null; }
    if (!canSeeNewThread(host.access())) { setNotice(needsFull(what, openLink.name)); return null; }
    return host;
  }

  /** Put a message on the clipboard; false when the phone couldn't. */
  async function copyMessage(text: string) {
    const ok = await writeClipboard(text, navigator.clipboard);
    if (!ok) setNotice("The phone couldn't copy that message.");
    return ok;
  }

  const nameIn = (id: string) => roomRef.current?.participants.find((p) => p.id === id)?.display_name ?? id;

  /** Quote a message in the box, or the `part` of it picked for Add to chat. A TL;DR instruction rides on a sent message but never shows, so the quote leaves it out. */
  function quoteMessage(paneId: string, message: Message, part?: string) {
    const next = part === undefined ? quoteFor({ ...message, text: splitTldr(message.text).text }, nameIn) : partQuote(message, part, nameIn);
    setQuotes((all) => ({ ...all, [paneId]: withQuote(all[paneId] ?? [], next) }));
  }

  /** More details: ask the bot that wrote a picked part to explain it, as on the desktop. It never sat in the box,
   *  but one that can't be sent, or is taken back from the queue, goes into it with its quote. */
  function explainPart(paneId: string, message: Message, part: string) {
    const shown = roomRef.current;
    if (!shown || shown.id !== paneId || shown.participants.length === 0 || !openLink) return;
    if (openLink.status !== "online") { setNotice(downLine(openLink)); return; }
    const quote = partQuote(message, part, nameIn);
    const body = moreDetailsText(quote, shown.participants);
    const key = `${paneId}\u0000${body}`;
    queuedDrafts.current.set(key, { draft: { text: MORE_DETAILS, files: [] }, quotes: [quote], inBox: false });
    stuckRef.current = true;
    queueFor(paneId, openLink.id).send(body).catch((error) => { queuedDrafts.current.delete(key); setNotice(words(error)); });
  }

  /** Pin a message for every model, or unpin it. */
  function togglePin(paneId: string, message: Message) {
    const shown = roomRef.current;
    if (!shown || shown.id !== paneId) return;
    const index = shown.pins.findIndex((pin) => pinSource(pin) === message.seq);
    if (index >= 0) { unpin(paneId, index); return; }
    if (pinPending.current) return;
    const host = changeHost("Pinning");
    if (!host) return;
    pinPending.current = true; setPinning(true);
    void host.backend.roomPin(paneId, responsePin(message.seq, splitTldr(message.text).text))
      .then((pins) => setRoom((current) => current && current.id === paneId ? { ...current, pins } : current))
      .catch((error) => setNotice(`Could not pin: ${words(error)}`))
      .finally(() => { pinPending.current = false; setPinning(false); });
  }

  function unpin(paneId: string, index: number) {
    if (pinPending.current) return;
    const host = changeHost("Unpinning");
    if (!host) return;
    pinPending.current = true; setPinning(true);
    void host.backend.roomUnpin(paneId, index)
      .then((pins) => setRoom((current) => current && current.id === paneId ? { ...current, pins } : current))
      .catch((error) => setNotice(`Could not unpin: ${words(error)}`))
      .finally(() => { pinPending.current = false; setPinning(false); });
  }

  /** Retry on a bot's reply, Revert on your message: delete from there and put this thread's files back. Asks first, as on the desktop. */
  async function goBack(paneId: string, message: Message) {
    const shown = roomRef.current;
    if (!shown || shown.id !== paneId) return;
    const kind: GoBack = message.speaker.kind === "bot" ? "retry" : "revert";
    if (Object.keys(shown.working).length > 0) { setNotice("Stop the bots first."); return; }
    const bot = message.speaker.kind === "bot" ? message.speaker.id : null;
    if (kind === "retry" && !shown.participants.some((p) => p.id === bot)) { setNotice(`${bot} isn't in this thread any more, so it can't answer again.`); return; }
    const host = changeHost(kind === "retry" ? "Retry" : "Revert");
    if (!host) return;
    try {
      const plan = await host.backend.roomRevertPlan(paneId, message.seq, bot);
      const going: GoingBack = { paneId, kind, message, plan, scope: "both", ticked: initialFiles(plan) };
      if (goBackAsks(goBackAlways(kind), plan)) setGoingBack(going);
      else await runGoBack(going);
    } catch (error) {
      setNotice(`Could not ${kind}: ${words(error)}`);
    }
  }

  async function runGoBack(going: GoingBack) {
    setGoingBack(null);
    const { paneId, kind, message, plan, scope, ticked } = going;
    const host = changeHost(kind === "retry" ? "Retry" : "Revert");
    if (!host) return;
    const bot = message.speaker.kind === "bot" ? message.speaker.id : null;
    const request = goBackRequest(kind === "retry" ? "both" : scope, plan, ticked);
    try {
      const failed = await host.backend.roomRevert(paneId, message.seq, bot, request.chat, request.files);
      if (request.chat) {
        setSavedSteps((saved) => saved && saved.id === paneId ? { id: paneId, index: dropStepsFrom(saved.index, loadedSteps.current, message.seq) } : saved);
        refreshSteps.current();
        setRoom((current) => current && current.id === paneId ? cutBack(current, message.seq) : current);
        // A reply that was cut off mid-way goes with the rest.
        setCuts((all) => { if (!all[paneId]) return all; const next = { ...all }; delete next[paneId]; return next; });
      }
      const line = failedLine(failed) ?? putBackLine(request.files);
      if (line) setNotice(line);
      // Your message goes back in the box, unsent.
      if (kind === "revert" && request.chat) setDrafts((all) => ({ ...all, [paneId]: { ...(all[paneId] ?? emptyDraft()), text: splitTldr(message.text).text } }));
      if (kind === "retry" && bot) { stuckRef.current = true; queueFor(paneId, host.machine.id).turn([bot], null); }
    } catch (error) {
      setNotice(`Could not ${kind}: ${words(error)}`);
    }
  }

  function answerGoBack(always: boolean) {
    if (!goingBack) return;
    if (always) saveGoBackAlways(goingBack.kind, true);
    void runGoBack(goingBack);
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
  // The open thread's queued messages, and whether Send would queue: everyone it goes to is mid-reply.
  const openRoom = room && openPane && room.id === openPane.id ? room : null;
  const openQueue = openPane ? queued[openPane.id] : undefined;
  const queuedRows = openQueue && openLink ? queuedViews(openQueue.items, Object.keys(openRoom?.working ?? {}), openQueue.paused, openQueue.lost,
    (pid) => openRoom?.participants.find((p) => p.id === pid)?.display_name ?? pid, openLink.name) : [];
  const nextTo = openRoom && answerers?.paneId === openRoom.id ? answerers.ids : [];
  const queueing = nextTo.length > 0 && nextTo.every((pid) => pid in (openRoom?.working ?? {}));
  const sendGate = botSendGate(openLink ? threadSend(links, openLink.id, draft.text, draft.files.length) : { enabled: false, reason: "This thread's machine isn't paired with this phone." }, viewingPending ? (session?.profiles.length ?? 0) : room?.participants.length ?? 0);
  const tints = hostTints(machines.filter((machine) => machine.kind === "server").map((machine) => machine.id));
  const machineIcon = (hostId: string, size = 16) => hostId === "local"
    ? <span className="ph-host-icon" title={linkOf(hostId)?.name}><Laptop size={size} /></span>
    : <span className="ph-host-icon" style={{ color: tints.get(hostId) ?? "var(--brand-cyan)" }} title={linkOf(hostId)?.name}><Globe size={size} /></span>;
  const started = Boolean(openPane && (openPane.assistantTaskId || (room && room.id === openPane.id ? room.messages.length : 0) > (openPane.fork?.at ?? 0) || openPane.activeAt));
  const inChat = tab === "threads" && openId !== null && (openPane !== null || viewingPending) && openWorkspace !== null && openLink !== null;
  const covered = composerOpen || sheet !== null || menu !== null || ask !== null || browse !== null || botSheet !== null || pairing !== null || assistantWorkspaceId !== null || personalOpen;
  // Settings and Machines sit above a tab, so the tab they were opened from stays lit.
  const shownTab = tab === "machines" ? machinesReturn.current : tab;
  const litTab = shownTab === "settings" || shownTab === "appearance" ? settingsReturn.current : shownTab;
  const menuPane = menu && (menu.kind === "thread" || menu.kind === "rename" || menu.kind === "bots") ? panes.find((pane) => pane.id === menu.id) ?? null : null;
  // A Bots sheet that can't show (thread closed or its room not loaded) must not leave the screen covered.
  const botsStale = menu?.kind === "bots" && !(menuPane && room && room.id === menuPane.id);
  useEffect(() => { if (botsStale) setMenu(null); }, [botsStale]);
  const menuProject = menu?.kind === "project" ? workspaces.find((workspace) => workspace.id === menu.id) ?? null : null;
  const askTarget = ask ? workspaces.find((workspace) => workspace.id === ask.workspaceId) ?? null : null;

  const callSlot = usePhoneCallSlot({ voice: phoneVoice, hostId: openHostId, roomId: openPane?.id ?? "" });
  const callWho: PhoneVoiceWho = (id) => (room && openPane && room.id === openPane.id ? room.participants : []).find((p) => p.id === id)?.look;
  return (
    <div className="ph-app" data-rev={tick}>
      <PhoneCallBar hidden={inChat && phoneVoice.controller.getState().scope?.roomId===openPane?.id} voice={phoneVoice} onOpen={(_host,room)=>{setTab("threads");setOpenId(room);}} />
      <div className="phone-frame">
        {!inChat && (
          <header className="ph-head" inert={covered}>
            {tab === "appearance"
              ? <BackButton label="Settings" onClick={() => setTab("settings")} />
              : tab === "settings"
              ? <BackButton label={tabName(settingsReturn.current)} onClick={() => setTab(settingsReturn.current)} />
              : tab === "machines"
              ? <BackButton label={tabName(machinesReturn.current)} onClick={() => { setOpenId(null); setSheet(null); setTab(machinesReturn.current); }} />
              : tab === "code" && terminalViewing
              ? <BackButton label="Code" onClick={() => setTerminalHomeSignal((n) => n + 1)} />
              : <h1 className="ph-large"><img className="ph-mark" src="/branding/mark.svg" alt="" width="26" height="26" />{tabName(tab)}</h1>}
            <span className="ph-head-actions">
              {tab === "threads" && newAllowed && <button type="button" className="ph-icon" aria-label="New thread" onClick={() => { setQuery(""); setMenu({ kind: "new" }); }}><Plus size={22} /></button>}
              {/* Machines is part of Settings, so it has no way back into Settings of its own. */}
              {tab !== "settings" && tab !== "appearance" && tab !== "machines" && <button type="button" className="ph-icon" aria-label="Settings" onClick={() => { settingsReturn.current = tab; setTab("settings"); setOpenId(null); }}><Settings size={20} /></button>}
            </span>
          </header>
        )}
        {inChat && openWorkspace && openLink ? (
          <ThreadView
            call={openPane && phoneVoice.canCall(openHostId) && phoneHost(openHostId) ? (button: boolean) => <VoiceCall voice={phoneVoice} hostId={openHostId} roomId={openPane.id} who={callWho} button={button} addressed={answerers?.paneId===openPane.id?answerers.ids:null} machine={openLink.name} link={phoneHost(openHostId)!.voice} canSetUp={!phoneHost(openHostId)!.access() || phoneHost(openHostId)!.access()?.tier==='full'} disabled={openLink.status!=='online'} Sheet={Sheet} /> : undefined}
            callSlot={callSlot}
            callStrip={openPane ? <PhoneCallStrip voice={phoneVoice} hostId={openHostId} roomId={openPane.id} who={callWho} /> : null}
            callCapsule={openPane ? <PhoneCallCapsule voice={phoneVoice} hostId={openHostId} roomId={openPane.id} who={callWho} /> : null}
            title={openPane?.title ?? "New thread"}
            draftThread={viewingPending}
            project={openWorkspace.name}
            machine={openLink.name}
            path={openPath}
            kind={openLink.kind}
            link={openLink}
            hostIcon={machineIcon(openLink.id, 15)}
            started={started}
            messages={room && openPane && room.id === openPane.id ? room.messages : []}
            approvals={room && openPane && room.id === openPane.id ? room.approvals : []}
            participants={room && openPane && room.id === openPane.id ? room.participants : []}
            toIds={room && openPane && room.id === openPane.id && answerers?.paneId === room.id ? answerers.ids : null}
            crewShut={crewShut}
            onCrew={foldCrew}
            onBot={setBotSheet}
            meters={room && openPane && room.id === openPane.id ? Object.fromEntries(room.configs.map((config) => {
              const provider = config.backend.kind === "agent" ? config.backend.tool : null;
              return [config.id, pillMeter(provider, room.fill[config.id], planOf(room.plans, provider, config.backend.kind === "agent" ? config.backend.model : null), new Date())];
            })) : {}}
            to={room && openPane && room.id === openPane.id && answerers?.paneId === room.id
              ? recipientName({ targets: answerers.ids, roster: room.participants.map((p) => ({ id: p.id, name: p.display_name })), policy: room.policy })
              : null}
            working={room && openPane && room.id === openPane.id ? room.working : {}}
            paneId={openPane?.id ?? ""}
            stepsIndex={openPane && savedSteps?.id === openPane.id ? savedSteps.index : null}
            loadedSteps={loadedSteps.current}
            loadSteps={async (seq) => {
              const host = phoneHost(openHostId);
              if (!host || !openPane) return null;
              const fromPane = openPane.id;
              const cache = loadedSteps.current;
              const reply = readReplySteps(await host.backend.roomSteps(fromPane, seq));
              rememberSteps(cache, openPaneRef.current, fromPane, seq, reply);
              return reply;
            }}
            cut={(openPane && cuts[openPane.id]) || NO_CUTS}
            onStop={(id) => { void stopBot(id); }}
            queued={queuedRows}
            queueing={queueing}
            steerAsk={steerAsk}
            onSteerAsk={setSteerAsk}
            onSteer={(item) => openPane && steerNow(openPane.id, item)}
            onUnqueue={(item) => openPane && unqueue(openPane.id, item)}
            onRemoveQueued={(item) => openPane && queues.current.get(openPane.id)?.remove(item)}
            onResume={() => openPane && queues.current.get(openPane.id)?.resume()}
            draft={draft}
            gate={sendGate}
            sending={sending}
            attaching={reading > 0}
            fork={openPane?.fork}
            approvalStays={openPane ? Boolean(approvalStays[openPane.id]) : false}
            other={links.find((link) => link.kind === "server" && link.status === "online" && link.id !== openLink.id) ?? null}
            endRef={endRef}
            onScrolled={(near) => { stuckRef.current = near; }}
            onResized={(chat) => { if (stuckRef.current) chat.scrollTop = chat.scrollHeight; }}
            covered={covered}
            onBack={() => { setOpenId(null); setSheet(null); }}
            onMenu={() => { if (openPane && !openPane.assistantTaskId) setMenu({ kind: "thread", id: openPane.id }); }}
            pins={room && openPane && room.id === openPane.id ? room.pins : []}
            pinning={pinning}
            onUnpin={(index) => { if (openPane) unpin(openPane.id, index); }}
            quotes={openId ? quotes[openId] ?? [] : []}
            onQuotes={(next) => { if (openId) setQuotes((all) => ({ ...all, [openId]: next })); }}
            actions={viewingPending || !openPane ? undefined : {
              onQuote: (message, part) => quoteMessage(openPane.id, message, part),
              onExplain: (message, part) => explainPart(openPane.id, message, part),
              onCopy: copyMessage,
              onPin: (message) => togglePin(openPane.id, message),
              onGoBack: (message) => { void goBack(openPane.id, message); },
              // A task's thread belongs to its assistant, so it has no Fork.
              onFork: openPane.assistantTaskId ? undefined : (seq) => {
                const hostId = workspaceHost(openWorkspace);
                if (!canStartOn(hostId)) { setNotice(needsFull("Forking", linkOf(hostId)?.name ?? "this machine")); return; }
                void forkFrom(openPane, seq);
              },
            }}
            goingBack={goingBack}
            onGoingBack={setGoingBack}
            onAnswerGoBack={answerGoBack}
            onDraft={(text) => openId && setDrafts((all) => { const now = all[openId] ?? emptyDraft(); return { ...all, [openId]: { ...now, text } }; })}
            onRemoveFile={(id) => openId && setDrafts((all) => { const now = all[openId] ?? emptyDraft(); return { ...all, [openId]: { ...now, files: now.files.filter((file) => file.id !== id) } }; })}
            onSend={() => { void send(); }}
            onDecide={decide}
            form={<QuestionForm phone view={formView(room?.asks)} nameOf={(pid) => room?.participants.find((p) => p.id === pid)?.display_name ?? pid}
              highlighted={-1} collapsed={false} notice={null} onHighlight={() => {}} onExpand={() => {}}
              onAnswer={(request, answers) => { void answer(request, answers); }} onStep={(step, by) => { void sendStep(step, by); }}
              onDismiss={() => setRoom((current) => current ? { ...current, asks: { ...current.asks, offer: null } } : current)} />}
            plan={room?.plan ?? false}
            tldr={tldrOf(openId)}
            onTldr={() => openId && setTldr(openId, !tldrOf(openId))}
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
            onSheet={openSheet}
            onOpenComposer={openComposer}
          />
        ) : tab === "threads" ? (
          <ThreadList
            sections={sections}
            workspaces={workspaces}
            links={links}
            folded={folded}
            draft={pending && draftVisible(draftFor(pending.id).text, draftFor(pending.id).files.length) ? { ...pending, text: draftFor(pending.id).text } : null}
            waiting={waiting}
            busy={busy}
            nameOf={(id) => session?.profiles.find((profile) => profile.id === id)?.display_name ?? id}
            loaded={session !== null}
            covered={covered}
            now={Date.now()}
            machineIcon={machineIcon}
            onToggle={(key) => setFolded((all) => ({ ...all, [key]: !foldChoice(all, key, key.startsWith("project:") && Boolean(workspaces.find((workspace) => `project:${workspace.id}` === key)?.collapsed)) }))}
            onOpen={openThread}
            onNew={newAllowed ? startIn : undefined}
            onPick={newAllowed ? () => { setQuery(""); setMenu({ kind: "new" }); } : undefined}
            onThreadMenu={(id) => { if (!panes.find((pane) => pane.id === id)?.assistantTaskId) setMenu({ kind: "thread", id }); }}
            onProjectMenu={(id) => setMenu({ kind: "project", id })}
            onMachines={() => { machinesReturn.current = "threads"; setTab("machines"); }}
            onRetry={(id) => phoneHost(id)?.connection.retryNow()}
            archived={sections.archived.length}
            onArchived={() => setMenu({ kind: "archived" })}
          />
        ) : tab === "settings" ? (
          <main className="ph-content" inert={covered}>
            <h2>Settings</h2>
            <p className="ph-intro">Preferences for this phone.</p>
            <div className="ph-list">
              <button type="button" className="ph-srow ph-preference" onClick={() => setTab("appearance")}><span className="ph-grow"><strong>Appearance</strong><small>{appearance.current.name} · Themes, glass and colors</small></span><ChevronRight size={15} /></button>
              <button type="button" className="ph-srow ph-preference" onClick={() => { machinesReturn.current = "settings"; setTab("machines"); }}><span className="ph-grow"><strong>Machines</strong><small>Connections and paired devices</small></span><ChevronRight size={15} /></button>
            </div>
          </main>
        ) : tab === "appearance" ? (
          <main className="ph-content ph-appearance" inert={covered}>
            <h2>Appearance</h2>
            <p className="ph-intro">Saved on this phone. Your Mac keeps its own appearance.</p>
            {appearanceSaveError && <p className="ph-banner" role="alert">This appearance is active, but couldn't be saved on this phone. Storage may be full or unavailable.</p>}
            <AppearanceSettings value={appearance} onChange={changeAppearance} textTransfer />
          </main>
        ) : tab === "machines" ? (
          <Machines
            machines={machines}
            links={links}
            routes={routes}
            covered={covered}
            pairing={plugin !== null}
            scan={scanner ? scanner.scan : null}
            autoScan={scanAtLaunch}
            onAutoScan={() => setScanAtLaunch(false)}
            incoming={incomingLink}
            onIncomingHandled={() => setIncomingLink(null)}
            onIncomingFailed={() => endLink("failed")}
            onPair={(request) => setPairing({ ...request, attempt: ++attemptSeq.current })}
            reserve={(link) => reserveLocal(gateRef.current!, link)}
            adopt={(link) => takeScan(gateRef.current!, link)}
            giveBack={(link) => gateRef.current!.release(link, "failed")}
            machineIcon={machineIcon}
            missing={[...new Set(workspaces.map((workspace) => workspaceHost(workspace)))].filter((id) => !machines.some((machine) => machine.id === id))}
            confirm={confirmUnpair}
            onAdd={(machine) => { setMachines((list) => addMachine(list, machine)); setNotice(`Pairing ${machine.name.trim()}…`); }}
            onEdit={(id, machine) => { setMachines(editMachine(machines, id, machine)); setNotice(`Saved ${machine.name.trim()}. Reconnecting…`); }}
            onUnpair={(id) => { setMachines((list) => removeMachine(list, id)); setConfirmUnpair(null); }}
            onConfirm={setConfirmUnpair}
            onRetry={(id) => phoneHost(id)?.connection.retryNow()}
            onError={setNotice}
          />
        ) : (
          <SideTab tab={tab} link={openLink ?? mac ?? null} host={openLink ? phoneHost(openLink.id) : macHost} hosts={hosts} terminalCwd={openWorkspace?.path ?? workspaces.find((workspace) => workspaceHost(workspace) === (openLink ?? mac)?.id)?.path ?? null} agents={agents} covered={covered} assistantProjects={assistantProjects} assistantRegistryErrors={assistantRegistryErrors} terminalSwitcherOpen={terminalSwitcherOpen} onTerminalSwitcherOpened={() => setTerminalSwitcherOpen(false)} terminalResumeSignal={terminalResumeSignal} onTerminalWaiting={setTerminalNeedsAnswer}
            terminalHomeSignal={terminalHomeSignal} onTerminalViewing={setTerminalViewing}
            personal={personal} onPersonal={() => setPersonalOpen(true)}
            library={<PhoneLibrary machines={libraryMachines} threads={panes} workspaces={workspaces} onOpenThread={openThread} />}
            bots={(session?.profiles ?? []).map((profile) => ({ ...toPerson(profile), tool: toolWords(profile), ...botDoing(profile.id) }))}
            onAssistant={(workspaceId) => {
              const workspace = workspaces.find((item) => item.id === workspaceId);
              if (!workspace) return;
              const projectHost = phoneHost(workspaceHost(workspace));
              if (!projectHost) { setNotice(`Pair ${workspaceHost(workspace)} with this phone to open its project assistant.`); return; }
              if (!canSeeNewThread(projectHost.access())) { setNotice(`Project assistant needs Full access on ${projectHost.machine.name}. Change this phone's level in that machine's Settings → Phones.`); return; }
              setAssistantWorkspaceId(workspace.id);
            }}
            onShow={() => {
            const host = openLink ? phoneHost(openLink.id) : macHost;
            if (!host || (openLink ?? mac)?.status !== "online") { setAgents([]); return; }
            host.backend.detectAgents().then((found) => setAgents(found.filter((agent) => agent.found).map((agent) => agent.label))).catch(() => setAgents([]));
          }} />
        )}
        {!inChat && <nav className="ph-tabs" aria-label="Sections" inert={covered}>
          {([[Command, "Agents", "agents"], [Terminal, "Code", "code"], [MessageSquare, "Threads", "threads"], [Folder, "Library", "library"]] as const).map(([Icon, label, item]) => (
            <button key={item} type="button" className={litTab === item ? "on" : ""} aria-current={tab === item ? "page" : undefined} aria-label={item === "code" ? "Code. Hold to switch terminals." : undefined} onPointerDown={item === "code" ? () => { codeHeld.current = false; if (codeHoldTimer.current) clearTimeout(codeHoldTimer.current); codeHoldTimer.current = setTimeout(() => { codeHeld.current = true; setTab("code"); setOpenId(null); setTerminalSwitcherOpen(true); }, 500); } : undefined} onPointerUp={item === "code" ? () => { if (codeHoldTimer.current) clearTimeout(codeHoldTimer.current); codeHoldTimer.current = null; } : undefined} onPointerLeave={item === "code" ? () => { if (codeHoldTimer.current) clearTimeout(codeHoldTimer.current); codeHoldTimer.current = null; } : undefined} onClick={() => { if (item === "code") { if (codeHeld.current) { codeHeld.current = false; return; } if (tab === "code") setTerminalResumeSignal((n) => n + 1); } setTab(item); if (item === "threads") setOpenId(null); }}>
              <Icon size={21} />{label}{item === "code" && terminalNeedsAnswer && <i className="ph-tabs-amber-dot" />}
            </button>
          ))}
        </nav>}
        {projectUndo && (
          <div className={`ph-undo${notice ? " ph-undo-up" : ""}`} role="status">
            <span>{projectUndo.name} removed.</span>
            <button type="button" onClick={() => undoRemoveProject()}>Undo</button>
          </div>
        )}
        {notice && (
          <div className="ph-toast" role="status">
            <span>{notice}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setNotice("")}><X size={16} /></button>
          </div>
        )}
        {personalOpen && (personal?.assistant || personal?.problem) && <div className="apex-agent-backdrop">
          <ApexAgentAll key={personal?.draftKey ?? 'legacy'} draftKey={personal?.draftKey} workspaces={[]} monitors={[]} personal={personal} serverStatusByLane={{ personal: 'Use Connections for integrations; direct tool commands are unavailable here.' }} onReply={async () => {}} onMutate={async () => {}} onReact={(laneId, messageId, emoji, enabled) => laneId === 'personal' && personal ? personal.react(messageId, emoji, enabled) : Promise.reject(new Error('That assistant lane is unavailable.'))} saveAttachment={async (laneId, name, bytes) => {
            if (laneId !== 'personal' || !personal?.assistant || personal.offline) throw new Error('The personal assistant host is unavailable.');
            return personal.saveAttachment(name, bytes);
          }} pickFolderUnavailableReason="Folder selection is unavailable on this phone." onSetUp={() => {}} onClose={() => setPersonalOpen(false)} />
        </div>}
        {assistantWorkspace && assistantWorkspaceHost && (canSeeNewThread(assistantWorkspaceHost.access())
          ? <div className="apex-agent-backdrop"><ApexAgentSources
            key={JSON.stringify([assistantWorkspace.id, workspaceHost(assistantWorkspace), assistantWorkspace.path])}
            workspace={assistantWorkspace}
            backend={assistantWorkspaceHost.backend}
            profiles={session?.profiles ?? []}
            panes={panes}
            assistantName={personal?.name}
            onBack={() => setAssistantWorkspaceId(null)}
            onClose={() => setAssistantWorkspaceId(null)}
          /></div>
          : <div className="apex-agent-backdrop"><section className="apex-agent" role="dialog" aria-modal="true" aria-label={`${assistantDisplayName(personal?.name)} for ${assistantWorkspace.name}`}><header className="apex-agent-head"><h1>Project access required</h1><button className="icon" onClick={() => setAssistantWorkspaceId(null)} aria-label={`Close ${assistantDisplayName(personal?.name)}`}>×</button></header><p className="ph-sheet-text">Project assistant needs Full access on {assistantWorkspaceHost.machine.name}. Change this phone's level in that machine's Settings → Phones.</p></section></div>)}
        {pairing && plugin && (
          <Sheet title={`Pair ${pairing.name}`} onClose={() => endLink("cancelled")}>
            <PairSheet key={pairing.attempt} plugin={plugin} link={pairing.link} label="iPhone" ready={ready} onFailed={() => settle("failed", false)} onClose={(why) => endLink(why === "failed" ? "failed" : "cancelled")} onPaired={(paired) => {
              const made: PairedMachine = { id: pairing.id, name: pairing.name, kind: pairing.kind, transport: "iroh", hostEndpointId: paired.hostEndpointId, addrs: paired.addrs, pairedAt: Date.now() };
              setMachines((list) => { try { return withPairedMachine(list, made); } catch (error) { setNotice(words(error)); return list; } });
              settle("paired", false);
            }} />
          </Sheet>
        )}
        {composerOpen && openWorkspace && openLink && <ComposerPanel
          onClose={() => setComposerOpen(false)}
          onPickerStart={startPicker}
          onPick={readAttachments}
          files={draft.files}
          onRemoveFile={(id) => openId && setDrafts((all) => { const now = all[openId] ?? emptyDraft(); return { ...all, [openId]: { ...now, files: now.files.filter((file) => file.id !== id) } }; })}
          onTools={() => { setComposerOpen(false); openSheet("tools"); }}
          project={openWorkspace.name}
          machine={openLink.name}
          onLocation={() => { setComposerOpen(false); openSheet("where"); }}
          plan={pending && openId === pending.id ? pendingDraftPlans[pending.id] ?? false : openRoom?.plan ?? false}
          planPending={(composerPlan.pending && composerPlan.roomId === openPane?.id) || sending}
          planDisabledReason={composerPlanDisabledReason({ pendingDraft: Boolean(pending && openId === pending.id), sending, online: openLink.status === "online", readOnly: phoneHost(openLink.id)?.access()?.tier === "read_only", offlineReason: downLine(openLink) })}
          onPlanChange={(on) => { void changeComposerPlan(on); }}
          planError={composerPlan.roomId === openPane?.id ? composerPlan.error : null}
        />}
        {ask && openPane && askTarget && (
          <Sheet title="Work on another machine?" onClose={() => setAsk(null)}>
            <p className="ph-sheet-text">“{openPane.title}” has started on {openLink?.name ?? "this machine"}, and a started thread stays on its machine. Open {askTarget.name} on {linkOf(workspaceHost(askTarget))?.name ?? "that machine"} as:</p>
            {canStartOn(workspaceHost(askTarget)) && <button type="button" className="primary ph-wide" onClick={() => { setAsk(null); startIn(askTarget); }}>New thread</button>}
            <button type="button" className="ph-wide" onClick={() => { void forkTo(openPane, askTarget); }}>Fork this thread<small>Copies the history. Nothing runs until you send.</small></button>
            <button type="button" className="ph-plain ph-wide" onClick={() => setAsk(null)}>Cancel</button>
          </Sheet>
        )}
        {sheet && openWorkspace && openLink && (
          <Sheet title={sheet === "project" ? "Project" : sheet === "where" ? "Where this runs" : "Tools"} onClose={() => setSheet(null)} variant={sheet === "where" ? "location" : undefined}>
            {sheet === "project" && <ProjectSheet rows={pickerRows(workspaces, panes, openWorkspace.id, (id) => linkOf(id)?.status !== "online")} links={links} query={query} machineIcon={machineIcon} onQuery={setQuery} onPick={pickWhere} />}
            {sheet === "where" && (
              <WorkSheet
                rows={workInRows(workspaces, machines.map((machine) => machine.id), openWorkspace, (id) => linkOf(id)?.status !== "online")}
                links={links}
                workspaces={workspaces}
                project={openWorkspace.name}
                stays={started ? openLink.name : null}
                machineIcon={machineIcon}
                onPick={pickWhere}
                onBrowse={(hostId) => { void openBrowse(hostId, openWorkspace, openPane?.id ?? null); setSheet(null); }}
                onProject={() => openSheet("project")}
              />
            )}
            {sheet === "tools" && (tools === null
              ? <p className="ph-sheet-text">Looking for tools on {openLink.name}…</p>
              : tools.length === 0
                ? <p className="ph-sheet-text">{openLink.status !== "online" ? downLine(openLink) : !openPane ? "Tools show once the thread has started." : `No tools on ${openLink.name} for this thread.`}</p>
                : <>
                  {tools.length > 8 && <input className="ph-search" type="search" placeholder="Search tools…" value={toolQuery} onChange={(event) => setToolQuery(event.target.value)} aria-label="Search tools" />}
                  {toolSearch(toolRows(tools), toolQuery).length === 0 && <p className="ph-sheet-text">No tools match “{toolQuery.trim()}”.</p>}
                  {toolSearch(toolRows(tools), toolQuery).map((tool) => (
                  <button key={tool.token} type="button" className="ph-srow" aria-label={`${tool.name}${tool.source ? `, from ${tool.source}` : ""}. Adds !${tool.token}`} onClick={() => { if (openId) setDraft(openId, { ...draft, text: appendToolToken(draft.text, tool.token) }); setSheet(null); }}>
                    <span className="ph-srow-icon"><Plug size={18} /></span>
                    <span className="ph-grow"><strong>{tool.name}{tool.source && <span className="ph-tool-source">· {tool.source}</span>}</strong><small className="ph-tool-token">!{tool.token}</small></span>
                  </button>
                  ))}
                </>)}
          </Sheet>
        )}
        {botSheet && room && openPane && openLink && room.id === openPane.id && (() => {
          const who = room.participants.find((p) => p.id === botSheet);
          const config = room.configs.find((c) => c.id === botSheet);
          if (!who || !config) return null;
          const provider = config.backend.kind === "agent" ? config.backend.tool : null;
          const reported = config.backend.kind === "agent" ? offered[`${openLink.id}:${config.backend.tool}`] ?? [] : [];
          const account = config.backend.kind === "open_ai_compatible" ? apiOffered[apiAccountKey(openLink.id, config.backend)] : undefined;
          const apiModels = account?.models ?? [];
          const turn = room.working[who.id];
          const asking = room.approvals.some((card) => card.id === who.id);
          const next = answerers?.paneId === room.id && answerers.ids.includes(who.id);
          const sharing = provider ? room.configs.filter((other) => other.backend.kind === "agent" && other.backend.tool === provider).length : 0;
          return (
            <BotSheet key={`${room.id}:${who.id}`} who={who} config={config} reported={reported} apiModels={apiModels}
              status={asking ? "Waiting on your answer" : turn ? `${toolLine(turnWords(turn, false, room.plan))} · ${elapsed(Math.max(0, Date.now() - turn.startedAt))}` : next ? "Answers your next message" : "Ready"}
              statusWarn={asking} working={Boolean(turn)} asking={asking}
              meters={botMeters(provider, room.fill[who.id], planOf(room.plans, provider, config.backend.kind === "agent" ? config.backend.model : null), new Date(), account?.balance ?? null)}
              shared={provider && sharing > 1 ? `The plan is shared by all ${sharing} ${TOOL_WORDS[provider] ?? provider} bots in this thread.` : ""}
              tokens={tokenWords(room.used[who.id])}
              resets={(() => {
                const credits = provider ? room.credits[provider] : undefined;
                const spend = phoneHost(openLink.id)?.backend.roomPlanReset;
                if (!provider || !credits || !spend) return null;
                return <PhoneResets credits={credits} windows={planOf(room.plans, provider, config.backend.kind === "agent" ? config.backend.model : null) ?? []} provider={toolName(provider)} offline={openLink.status !== "online" ? downLine(openLink) : ""} use={(credit) => {
                  const which = `${openLink.id}:${provider}:${credit?.id ?? ""}`;
                  const key = resetKeys.current.get(which) ?? crypto.randomUUID();
                  resetKeys.current.set(which, key);
                  return spend(room.id, provider, credit?.id ?? null, key).then((outcome) => { resetKeys.current.delete(which); return outcome; });
                }} />;
              })()}
              offline={openLink.status !== "online" ? downLine(openLink) : ""}
              onSave={(change) => saveTurn(room.id, openLink.id, who.id)({ change, reported, apiModels })}
              onMention={() => { if (openId) setDraft(openId, { ...draft, text: tagFromBar(draft.text, who, room.participants) }); setBotSheet(null); }}
              onStop={() => { void stopBot(who.id); setBotSheet(null); }}
              onClose={() => setBotSheet(null)} />
          );
        })()}
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
                <p className="ph-meta">{link && link.status !== "online" ? `${downLine(link)} · ` : ""}{menuPane.activeAt ? activeWords(ageWords(Date.now() - menuPane.activeAt)) : "Not started"}</p>
              </div>
              {menuPane.id === openId && room && room.id === openPane?.id && (
                <button type="button" className="ph-srow ph-bots-menu" onClick={() => { setBotChange(null); setMenu({ kind: "bots", id: menuPane.id }); }}>
                  <span className="ph-grow"><strong>Bots</strong><small>{room.participants.length} in this thread</small></span>
                  <span className="ph-bots-preview">{room.participants.slice(0, 4).map((who) => <Avatar key={who.id} seed={who.look.seed} color={who.look.color} size="sm" />)}</span>
                  <ChevronRight size={18} />
                </button>
              )}
              <MenuRow label={menuPane.pinned ? "Unpin" : "Pin"} onClick={() => { patchPane(menuPane.id, (item) => ({ ...item, pinned: item.pinned ? undefined : true })); setMenu(null); }} />
              <MenuRow label="Rename…" onClick={() => setMenu({ kind: "rename", id: menuPane.id, text: menuPane.title })} />
              {!menuPane.unread && <MenuRow label="Mark as unread" onClick={() => { patchPane(menuPane.id, (item) => ({ ...item, unread: true })); setMenu(null); if (openId === menuPane.id) setOpenId(null); }} />}
              {workspace?.path && <MenuRow label="Copy folder path" onClick={() => { copyPath(workspace.path); setMenu(null); }} />}
              <MenuRow label="Archive" danger onClick={() => { patchPane(menuPane.id, (item) => ({ ...item, archived: true, pinned: undefined })); setMenu(null); if (openId === menuPane.id) setOpenId(null); }} />
            </Sheet>
          );
        })()}
        {menu?.kind === "bots" && menuPane && room && room.id === menuPane.id && (() => {
          const host = workspaces.find((item) => item.id === menuPane.workspaceId) ? phoneHost(workspaceHost(workspaces.find((item) => item.id === menuPane.workspaceId)!)) : null;
          const full = !!host && canStartOn(host.machine.id);
          const absent = (session?.profiles ?? []).filter((profile) => !room.configs.some((config) => config.id === profile.id));
          const change = async (config: ParticipantConfig, remove: boolean) => {
            if (!host || botChangeLock.current || botChangeGate(full, remove && (busy[room.id] ?? []).includes(config.id), false)) return;
            botChangeLock.current = true;
            setBotChange({ roomId: room.id, botId: config.id, pending: true, error: "" });
            try {
              if (remove) await host.backend.roomRemoveParticipant(room.id, config.id);
              else await host.backend.roomAddParticipant(room.id, config);
              setRoom((current) => current && current.id === room.id ? {
                ...current,
                configs: remove ? current.configs.filter((item) => item.id !== config.id) : [...current.configs.filter((item) => item.id !== config.id), config],
                participants: remove ? current.participants.filter((item) => item.id !== config.id) : [...current.participants.filter((item) => item.id !== config.id), toPerson(config)],
              } : current);
              setBotChange(null);
            } catch (error) {
              setBotChange({ roomId: room.id, botId: config.id, pending: false, error: words(error) });
            } finally { botChangeLock.current = false; }
          };
          const row = (config: ParticipantConfig, member: boolean) => {
            const who = toPerson(config);
            const state = botChange?.roomId === room.id && botChange.botId === config.id ? botChange : null;
            const reason = botChangeGate(full, member && (busy[room.id] ?? []).includes(config.id), botChangeLock.current);
            return <div className="ph-bot-entry" key={config.id}>
              <div className="ph-bot-row">
                <button type="button" className="ph-bot-info" disabled={!member} onClick={() => { setMenu(null); setBotSheet(config.id); }}>
                  <Avatar seed={who.look.seed} color={who.look.color} size="sm" />
                  <span className="ph-bot-label"><strong>{config.display_name}</strong><small>@{mentionFor(config)}{member && "model" in config.backend && config.backend.model ? ` · ${config.backend.model}` : ""}</small></span>
                </button>
                <button type="button" className={`ph-bot-action${member ? " remove" : ""}`} aria-label={`${member ? "Remove" : "Add"} ${config.display_name}`} disabled={!!reason} title={reason} onClick={() => void change(config, member)}>
                  {state?.pending ? <span className="ph-bot-spinner" aria-label="Saving" /> : member ? <span aria-hidden="true">−</span> : <Plus size={18} />}
                </button>
              </div>
              {member && (busy[room.id] ?? []).includes(config.id) && <p className="ph-meta">Stop this bot’s reply before removing it.</p>}
              {state?.error && <p className="ph-bot-error" role="alert">{state.error} <button type="button" disabled={!!reason} onClick={() => void change(config, member)}>Retry</button></p>}
            </div>;
          };
          return (
            <Sheet title="Bots" onClose={() => setMenu(null)}>
              {!full && <p className="ph-sheet-text">{botChangeGate(false, false, false)}</p>}
              <div className="ph-section">In this thread</div>
              {room.configs.length === 0 ? <div className="ph-card"><strong>No bots yet</strong><p className="ph-meta">Add a bot below to send a message.</p></div> : <div className="ph-bot-list">{room.configs.map((config) => row(config, true))}</div>}
              <div className="ph-section">Add a bot</div>
              <div className="ph-bot-list">{absent.map((profile) => row(profile, false))}</div>
              {absent.length === 0 && <p className="ph-meta">Every saved bot is already here. Make new ones on the Mac.</p>}
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
              {canStartOn(workspaceHost(menuProject)) && <MenuRow label="New thread here" onClick={() => startIn(menuProject)} />}
              <MenuRow label={menuProject.pinned ? "Unpin project" : "Pin project"} onClick={() => {
                saveSession((current) => ({ ...current, workspaces: current.workspaces.map((item) => item.id === menuProject.id ? { ...item, pinned: item.pinned ? undefined : true } : item) })).catch((error) => setNotice(words(error)));
                setMenu(null);
              }} />
              {menuProject.path && <MenuRow label="Copy folder path" detail={folderCopyText(menuProject.path)} onClick={() => { copyPath(menuProject.path); setMenu(null); }} />}
              {newAllowed && <MenuRow label="Remove project…" danger onClick={() => setMenu({ kind: "remove", id: menuProject.id })} />}
            </Sheet>
          );
        })()}
        {menu?.kind === "archived" && (
          <Sheet title="Archived" onClose={() => setMenu(null)}>
            <p className="ph-sheet-text">{sections.archived.length === 0 ? "No archived threads." : "Tap one to bring it back to its project and open it."}</p>
            {sections.archived.map((pane) => {
              const workspace = workspaces.find((item) => item.id === pane.workspaceId) ?? null;
              const link = workspace ? hostOf(workspace) : null;
              return (
                <button key={pane.id} type="button" className="ph-arch-row" disabled={!newAllowed} onClick={() => { void restoreArchived(pane.id); }}>
                  <strong>{pane.title}</strong>
                  <small>{archivedDetail({ project: workspace?.name, machine: link?.name, age: pane.activeAt ? ageWords(Date.now() - pane.activeAt) : undefined })}</small>
                </button>
              );
            })}
            {!newAllowed && <p className="ph-sheet-text">{"Restoring needs Full access on your Mac. Change this phone's level in the Mac's Settings → Phones."}</p>}
          </Sheet>
        )}
        {menu?.kind === "remove" && (() => {
          const project = workspaces.find((workspace) => workspace.id === menu.id);
          if (!project) return null;
          const threads = panes.filter((pane) => pane.workspaceId === project.id && pane.kind === "chat");
          const asked = removeProjectWords(project.name, threads.filter((pane) => !pane.archived).length, threads.filter((pane) => pane.archived).length);
          return (
            <Sheet title={asked.title} onClose={() => setMenu(null)}>
              <p className="ph-sheet-text">{asked.body}</p>
              <button type="button" className="danger ph-wide" onClick={() => removeProject(project.id)}>{asked.action}</button>
              <button type="button" className="ph-plain ph-wide" onClick={() => setMenu(null)}>Cancel</button>
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

/** The phone's one back button: the iOS chevron, as in a thread's title bar, then where it goes. */
function BackButton({ label, onClick, className }: { label: string; onClick(): void; className?: string }) {
  return <button type="button" className={`ph-back${className ? ` ${className}` : ""}`} aria-label={`Back to ${label}`} onClick={onClick}><ChevronLeft size={26} />{label}</button>;
}

function Sheet({ title, onClose, children, variant }: { title: string; onClose(): void; children: ReactNode; variant?: "location" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="ph-sheet-back" onClick={onClose}>
      <div className={`ph-sheet${variant ? ` ph-sheet-${variant}` : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
        <div className="ph-handle" />
        <div className={`ph-sheet-title${variant ? ` ph-sheet-title-${variant}` : ""}`}>
          <h3>{title}</h3>
          <button type="button" className="ph-icon" aria-label="Close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className={`ph-sheet-body${variant ? ` ph-sheet-body-${variant}` : ""}`}>{children}</div>
      </div>
    </div>
  );
}

/** A held bot: what it runs on, how much it has left, and its model and reasoning, which save as they're picked, as on the desktop. */
function BotSheet(props: {
  who: Person; config: ParticipantConfig; reported: ModelChoice[];
  /** What an API bot's provider lists; empty for other bots, or until the machine answers. */
  apiModels: ApiModel[];
  status: string; statusWarn: boolean; working: boolean; asking: boolean;
  meters: MeterRow[]; shared: string; tokens: string;
  /** The provider's usage resets, when it granted any. */
  resets: ReactNode;
  /** Why the bot's machine can't take changes right now; empty while it's online. */
  offline: string;
  onSave(change: TurnChange): Promise<void>; onMention(): void; onStop(): void; onClose(): void;
}) {
  const backend = props.config.backend;
  const tool = backend.kind === "agent" ? backend.tool : null;
  const savedModel = "model" in backend ? backend.model ?? "" : "";
  const [model, setModel] = useState(savedModel);
  const [effort, setEffort] = useState(props.config.effort ?? "");
  const [speed, setSpeed] = useState<Speed | "">(props.config.speed ?? "");
  const [typed, setTyped] = useState(savedModel);
  const [view, setView] = useState<"bot" | "models">("bot");
  const [result, setResult] = useState<{ saving: boolean; error: string; saved: boolean }>({ saving: false, error: "", saved: false });
  // Picks not yet saved go in each write together, so a newer pick never drops an older one.
  // Once saved they're dropped, so a later write doesn't undo a change made on the Mac since.
  const touched = useRef<TurnChange>({});
  const version = useRef(0);
  const saved = useRef(props.config);
  saved.current = props.config;
  // Bumped once a save lands and its picks leave `touched`, so the effect below runs again after that.
  const [settled, setSettled] = useState(0);
  // Show the bot as its machine has it (after a save, or a change from the Mac), except picks still saving.
  const savedEffort = props.config.effort ?? "";
  const savedSpeed = props.config.speed ?? "";
  const shownModel = useRef(savedModel);
  useEffect(() => {
    if (!("model" in touched.current)) {
      const before = shownModel.current;
      shownModel.current = savedModel;
      setModel(savedModel);
      // A model name half typed into the box stays; only one still showing the old model follows.
      setTyped((current) => current === before ? savedModel : current);
    }
    if (!("effort" in touched.current)) setEffort(savedEffort);
    if (!("speed" in touched.current)) setSpeed(savedSpeed);
  }, [savedModel, savedEffort, savedSpeed, settled]);
  const choices = tool ? modelChoices(tool, props.reported) : backend.kind === "open_ai_compatible" ? apiModelChoices(props.apiModels, savedModel) : null;
  // Who lists an API bot's models, for the menu's note.
  const lister = tool ? toolName(tool) : apiProviderName(props.config) ?? "this provider";
  const groups = choices?.groups ?? [];
  const all = choices ? [...choices.shown, ...choices.extra] : [];
  const [more, setMore] = useState(() => choices?.extra.some((m) => m.id === savedModel) ?? false);
  const levels = reasoningLevels(props.config, groups, model);
  const editable = backend.kind === "agent" || backend.kind === "open_ai_compatible";
  const name = props.who.display_name;
  // The row is narrow, so an API model's context size is left to the line under the bot's name.
  const modelName = (id: string) => id ? (tool ? all.find((m) => m.id === id)?.label : apiModelName(props.apiModels, id)) ?? id : "Default";
  const note = model ? all.find((m) => m.id === model)?.note : undefined;

  const apply = async (change: TurnChange) => {
    const sent = { ...touched.current, ...change };
    touched.current = sent;
    const mine = ++version.current;
    setResult({ saving: true, error: "", saved: false });
    try {
      await props.onSave(sent);
      const left: TurnChange = { ...touched.current };
      if (left.model === sent.model) delete left.model;
      if (left.effort === sent.effort) delete left.effort;
      if (left.speed === sent.speed) delete left.speed;
      touched.current = left;
      setSettled((n) => n + 1);
      if (mine === version.current) setResult({ saving: false, error: "", saved: true });
    } catch (error) {
      if (mine !== version.current) return;
      // Nothing was written: show the bot as its machine has it.
      touched.current = {};
      const now = saved.current;
      setModel("model" in now.backend ? now.backend.model ?? "" : "");
      setEffort(now.effort ?? "");
      setSpeed(now.speed ?? "");
      setResult({ saving: false, error: words(error), saved: false });
    }
  };
  const pick = (id: string) => {
    setModel(id);
    if (!reasoningLevels(props.config, groups, id).includes(effort)) setEffort("");
    setView("bot");
    if (id !== model) void apply({ model: id });
  };
  const modelRow = (m: { id: string; label?: string | null }) => (
    <button key={m.id || "default"} type="button" role="menuitemradio" aria-checked={model === m.id} className="ph-srow" onClick={() => pick(m.id)}>
      <span className="ph-grow"><strong>{m.id ? m.label ?? m.id : "Default"}</strong>{m.id ? m.label && <small>{m.id}</small> : <small>Whatever {tool ? toolName(tool) : "the tool"} picks for this account</small>}</span>
      {model === m.id && <span className="ph-srow-icon"><Check size={18} /></span>}
    </button>
  );

  if (view === "models" && choices) {
    return (
      <Sheet title="Model" onClose={props.onClose}>
        <BackButton className="ph-sheet-back-link" label={name} onClick={() => setView("bot")} />
        <div className="ph-group" role="menu" aria-label={`Model for ${name}`}>
          {tool && modelRow({ id: "" })}
          {model && !all.some((m) => m.id === model) && modelRow({ id: model })}
          {choices.shown.map(modelRow)}
          {choices.extra.length > 0 && (
            <button type="button" className="ph-srow" aria-expanded={more} onClick={() => setMore((open) => !open)}>
              <span className="ph-grow"><strong>{more ? "Fewer models" : "More models"}</strong></span>
              <span className="ph-srow-icon ph-muted-icon">{more ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
            </button>
          )}
          {more && choices.extra.map(modelRow)}
        </div>
        <p className="ph-sheet-text ph-quiet">{!tool ? `The models ${lister} offers this account.` : props.reported.length ? `The models ${lister} offers this account, then other known ones.` : `The models Deck knows for ${lister}.`}</p>
      </Sheet>
    );
  }

  return (
    <Sheet title="In this thread" onClose={props.onClose}>
      <div className="ph-bot-head" style={{ "--agent-color": props.who.look.color } as CSSProperties}>
        <Avatar seed={props.who.look.seed} color={props.who.look.color} size="lg" working={props.working && !props.asking} />
        <span className="ph-grow">
          <strong>{name}</strong>
          <small>{settingsLine({ ...props.config, backend: "model" in backend ? { ...backend, model: model || null } as ParticipantConfig["backend"] : backend, effort: effort || null, speed: speed || null }, props.reported, props.apiModels)}</small>
          <small className={props.statusWarn ? "ph-amber" : undefined}>{props.status}</small>
        </span>
      </div>
      <div className="ph-card ph-meters" role="group" aria-label={`What ${name} has left`} style={{ "--who": props.who.look.color } as CSSProperties}>
        {props.meters.map((row) => (
          <div key={row.key} className={`ph-meter${row.low ? " low" : ""}`}>
            <p><span>{row.label}</span><b>{row.value}{row.low && " low"}</b></p>
            <span className="ph-meter-track" aria-hidden="true">{row.left !== null && <i style={{ width: `${percent(row.left)}%` }} />}</span>
            {row.detail && <small>{row.detail}</small>}
          </div>
        ))}
        {props.shared && <p className="ph-meter-note">{props.shared}</p>}
        <p className="ph-meter-note">{props.tokens}</p>
      </div>
      {props.resets}
      {editable ? <>
        <div className="ph-section">Model and reasoning</div>
        <fieldset className="ph-group ph-turn" disabled={Boolean(props.offline)} aria-busy={result.saving}>
          {choices ? (
            <button type="button" className="ph-srow" aria-haspopup="menu" onClick={() => setView("models")}>
              <span className="ph-grow"><strong>Model</strong></span>
              <span className="ph-srow-value">{modelName(model)}</span>
              <ChevronRight size={16} />
            </button>
          ) : (
            <form className="ph-srow ph-model-typed" onSubmit={(event) => { event.preventDefault(); if (typed.trim() && typed.trim() !== model) { setModel(typed.trim()); void apply({ model: typed.trim() }); } }}>
              <label className="ph-grow"><strong>Model</strong><input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="Model name" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
              <button type="submit" className="primary" disabled={!typed.trim() || typed.trim() === model}>Save</button>
            </form>
          )}
          <div className="ph-reasoning">
            <ReasoningSlider efforts={levels} value={levels.includes(effort) ? effort : ""} onCommit={(value) => { setEffort(value); if (value !== (levels.includes(effort) ? effort : "")) void apply({ effort: value }); }} />
          </div>
          {phoneSpeed(props.config) && (
            <div className="ph-speed">
              <strong>Speed</strong>
              <div className="ph-segment" role="radiogroup" aria-label="Speed">
                {SPEED_OPTIONS.map((option) => (
                  <button key={option.value || "default"} type="button" role="radio" aria-checked={speed === option.value} title={option.title} onClick={() => { if (option.value !== speed) { setSpeed(option.value); void apply({ speed: option.value }); } }}>{option.text}</button>
                ))}
              </div>
              <small>{speedHint(tool!)}</small>
            </div>
          )}
        </fieldset>
        {note && <p className="ph-sheet-text ph-quiet">{note}</p>}
        <p className={`ph-sheet-text ph-turn-note${result.error ? " ph-red" : props.offline ? " ph-amber" : ""}`} role={result.error ? "alert" : "status"}>
          {props.offline ? `${props.offline}. Model, reasoning and speed can change once it's back.`
            : result.error ? `Couldn't save: ${result.error}`
            : result.saving ? "Saving…"
            : result.saved ? props.working ? `Saved. ${name} finishes this reply first, then uses it.` : `Saved. ${name} uses it from its next reply.`
            : "Changes save as you pick them, for this thread only."}
        </p>
      </> : <p className="ph-sheet-text ph-quiet">This bot has no model or reasoning to change.</p>}
      <button type="button" className="primary ph-wide" onClick={props.onMention}>Mention {name}</button>
      {props.working && !props.offline && <button type="button" className="ph-wide" onClick={props.onStop}>Stop {name}</button>}
      <p className="ph-sheet-text ph-quiet">Add or remove bots from Bots in the thread’s ⋯ menu.</p>
    </Sheet>
  );
}

const toolName = (tool: AgentTool) => TOOL_WORDS[tool] ?? tool;
const apiModelName = (models: ApiModel[], id: string) => models.find((m) => m.id === id)?.label || undefined;
/** One API account on one machine: its address and the name its key is saved under. */
const apiAccountKey = (hostId: string, backend: { base_url: string; api_key_env: string | null }) => `${hostId}:${backend.base_url.trim().replace(/\/+$/, "")}|${backend.api_key_env ?? ""}`;

function MenuRow({ label, detail, danger, onClick }: { label: string; detail?: string; danger?: boolean; onClick(): void }) {
  return (
    <button type="button" className={`ph-srow${danger ? " ph-red" : ""}`} onClick={onClick}>
      <span className="ph-grow"><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
    </button>
  );
}

function ThreadView(props: {
  /** The mic beside Send and the call's sheet; `button` is false while the box shows Send in its place. */
  call?: (button: boolean) => ReactNode;
  callSlot: { live: boolean; look: CallLook; hint: string };
  /** Look A's strip above the compose row, and look C's capsule under the title. Each draws only in its look. */
  callStrip?: ReactNode; callCapsule?: ReactNode;
  title: string; draftThread: boolean; project: string; machine: string; path: string; kind: MachineKind; link: LinkView;
  hostIcon: ReactNode; started: boolean; covered: boolean;
  messages: Message[]; approvals: { id: string; request: string; action: import("../types").ProposedAction }[];
  participants: Person[]; working: PhoneWorking; cut: PhoneCuts;
  paneId: string; stepsIndex: import("../types").StepsIndex | null; loadedSteps: Map<number, import("../types").ReplySteps>; loadSteps(seq: number): Promise<import("../types").ReplySteps | null>; draft: Draft; gate: { enabled: boolean; reason: string };
  /** Who a message without an @name goes to: "Null", "everyone"; null while unknown. */
  to: string | null;
  /** The same, as bot ids, for the bar to light up. */
  toIds: string[] | null;
  /** The bot bar is folded into the title bar; the phone remembers this for every thread. */
  crewShut: boolean; onCrew(shut: boolean): void; onBot(id: string): void;
  /** Each bot's context hairline and plan dot, for its pill. */
  meters: Record<string, PillMeter>;
  fork?: Pane["fork"]; approvalStays: boolean; other: LinkView | null; endRef: RefObject<HTMLDivElement | null>;
  onBack(): void; onMenu(): void; onDraft(text: string): void; onRemoveFile(id: string): void; onScrolled(near: boolean): void; onResized(chat: HTMLElement): void;
  sending: boolean; attaching: boolean; onSend(): void; onDecide(request: string, approve: boolean, always: boolean): Promise<void>; onRetry(): void;
  onStop(id: string): void; onOpenOther(hostId: string): void; onSheet(sheet: SheetKind): void; onOpenComposer(): void;
  /** Messages waiting on the phone for a bot to finish, oldest first. */
  queued: QueuedView[];
  /** Everyone the next message goes to is mid-reply, so Send queues it. */
  queueing: boolean;
  /** The queued message whose Steer now is asking first. */
  steerAsk: number | null; onSteerAsk(id: number | null): void; onSteer(id: number): void;
  onUnqueue(id: number): void; onRemoveQueued(id: number): void; onResume(): void;
  /** The question or next steps, above the composer. */
  form: ReactNode; plan: boolean; onStopPlanning(): void;
  /** TL;DR mode: every bot is asked for a short answer. */
  tldr: boolean; onTldr(): void;
  /** Pinned for every model in the thread; a pinned message's pin jumps to it. */
  pins: string[]; pinning: boolean; onUnpin(index: number): void;
  /** Messages quoted in the box, waiting to go with the next message. */
  quotes: ReplyQuote[]; onQuotes(next: ReplyQuote[]): void;
  /** The row under each message, as on the desktop. Absent in an unsent new thread. */
  actions?: {
    /** Quote the message, or only the `part` picked in it (Add to chat). */
    onQuote(message: Message, part?: string): void;
    /** More details on a part picked in a message. */
    onExplain(message: Message, part: string): void;
    onCopy(text: string): Promise<boolean>;
    onPin(message: Message): void;
    onGoBack(message: Message): void;
    /** Absent where a thread can't be forked. */
    onFork?: (seq: number) => void;
  };
  /** The Retry or Revert question open under a message. */
  goingBack: GoingBack | null; onGoingBack(next: GoingBack | null): void; onAnswerGoBack(always: boolean): void;
}) {
  const paused = props.link.status !== "online";
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The keyboard is up while the box has focus; the bot bar folds away until it goes down.
  const [typing, setTyping] = useState(false);
  const crew = crewOpen(props.crewShut, typing);
  const pill = usePillPress();
  // Cards show read-only on the phone for now, at their defaults.
  const versions = useMemo(() => cardVersions(props.messages), [props.messages]);
  // The message whose › (or ‹) is open, and the one whose Copy reads "Copied" for a moment, by seq.
  const [messageMenu, setMessageMenu] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  useEffect(() => { setMessageMenu(null); setCopied(null); }, [props.paneId]);
  // A tap anywhere but a message's actions folds them, as a click away does on the desktop; so does Escape.
  useEffect(() => {
    if (messageMenu === null) return;
    const away = (event: Event) => { if (!(event.target as Element).closest?.(".message-actions")) setMessageMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      chatRef.current?.querySelector<HTMLButtonElement>(`[data-message-more="${messageMenu}"]`)?.focus();
      setMessageMenu(null);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", key, true); };
  }, [messageMenu]);
  // The Retry or Revert question opens under its message; bring it into view.
  useEffect(() => {
    if (props.goingBack) chatRef.current?.querySelector(".ph-goback")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [props.goingBack?.message.seq]);
  // Send to ▾ over the quotes: who they're handed to.
  const [handOffOpen, setHandOffOpen] = useState(false);
  useEffect(() => { if (props.quotes.length === 0) setHandOffOpen(false); }, [props.quotes.length]);
  const quoteTo = props.quotes.length ? quoteTarget(props.draft.text.trim(), props.quotes, props.participants) : null;
  const copy = (seq: number, text: string) => {
    void props.actions?.onCopy(text).then((ok) => {
      if (!ok) return;
      setCopied(seq);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
    });
  };
  /** The row under a message and, when it is asking, its Retry or Revert question. */
  const actionsFor = (message: Message, shown: string) => {
    const actions = props.actions;
    if (!actions) return null;
    const going = props.goingBack && props.goingBack.paneId === props.paneId && props.goingBack.message.seq === message.seq ? props.goingBack : null;
    const who = message.speaker.kind === "bot" ? person(message.speaker.id).display_name : "";
    return <>
      <MessageActions message={message} now={now} who={who} shown={shown}
        expanded={messageMenu === message.seq} onToggle={() => setMessageMenu((open) => open === message.seq ? null : message.seq)}
        copied={copied === message.seq} onCopy={() => copy(message.seq, shown)}
        onQuote={() => { actions.onQuote(message); inputRef.current?.focus(); }}
        pinned={props.pins.some((pin) => pinSource(pin) === message.seq)} pinning={props.pinning} onPin={() => actions.onPin(message)}
        busy={working.length > 0} onGoBack={() => actions.onGoBack(message)}
        onFork={actions.onFork && (() => actions.onFork?.(message.seq))}
        asking={going !== null} />
      {going && <GoBackAsk going={going} who={who || "the bot"} nameOf={(id) => person(id).display_name}
        onScope={(scope) => props.onGoingBack({ ...going, scope })}
        onTick={(path) => props.onGoingBack({ ...going, ticked: going.ticked.includes(path) ? going.ticked.filter((p) => p !== path) : [...going.ticked, path] })}
        onAnswer={props.onAnswerGoBack} onCancel={() => props.onGoingBack(null)} />}
    </>;
  };
  const tag = (id: string) => {
    const text = tagFromBar(props.draft.text, props.participants.find((p) => p.id === id), props.participants);
    props.onDraft(text);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(text.length, text.length); });
  };
  const everyone = props.participants.length > 1 && props.toIds !== null && props.participants.every((p) => props.toIds!.includes(p.id));
  // Typing @ offers the thread's bots above the box; only while the box has the keyboard.
  const [caret, setCaret] = useState<number | null>(null);
  const picking = caret !== null && !paused && props.participants.length > 0 ? mentionPicks(props.draft.text, caret, props.participants) : null;
  const choose = (handle: string) => {
    const next = pickMention(props.draft.text, caret ?? props.draft.text.length, picking?.trigger ?? null, handle);
    props.onDraft(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(next.caret, next.caret); });
  };
  // Size the box to its text whenever the draft loads or changes, not only while typing.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }, [props.draft.text]);
  const working = Object.entries(props.working);
  const cut = Object.entries(props.cut);
  // Steer now's question opens at the bottom of the chat; bring it above the message box.
  const steerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (props.steerAsk !== null) steerRef.current?.scrollIntoView({ block: "nearest" }); }, [props.steerAsk]);
  // The keyboard, or a taller message box, shortens the chat from below. If you were at the end,
  // keep the end in view, as Messages does, instead of letting the newest messages slide under the box.
  const chatRef = useRef<HTMLElement>(null);
  const resizedRef = useRef(props.onResized);
  resizedRef.current = props.onResized;
  useEffect(() => {
    const box = chatRef.current;
    if (!box) return;
    const watch = new ResizeObserver(() => resizedRef.current(box));
    watch.observe(box);
    return () => watch.disconnect();
  }, []);
  // The title's second line: the project always shows in full, and the machine shortens into the room left.
  // When not even 5.5em is left, the machine drops out; tapping the title still names it in "Where this runs".
  const contextRef = useRef<HTMLParagraphElement>(null);
  const [machineFits, setMachineFits] = useState(true);
  useLayoutEffect(() => {
    const line = contextRef.current;
    if (!line) return;
    const fit = () => {
      const parts = [...line.children] as HTMLElement[];
      const project = parts.find((part) => part.classList.contains("ph-context-project"));
      if (!project) return;
      const style = getComputedStyle(line);
      const icons = parts.filter((part) => !part.classList.contains("ph-context-project") && !part.classList.contains("ph-context-machine"))
        .reduce((sum, part) => sum + part.getBoundingClientRect().width, 0);
      // Three gaps once the machine is in: icon, project, machine, chevron.
      const room = line.clientWidth - icons - project.scrollWidth - 3 * (parseFloat(style.columnGap) || 0);
      setMachineFits(room >= 5.5 * parseFloat(style.fontSize));
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(line);
    return () => watch.disconnect();
  }, [props.project, props.machine, props.started]);
  const lost = cut.filter(([id, part]) => !part.ended && !(id in props.working)).map(([id]) => id);
  const ended = cut.filter(([, part]) => part.ended).map(([id]) => id);
  // Count working seconds and keep message dates current while idle or after sleep.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = setInterval(refresh, working.length > 0 ? 1000 : 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [working.length > 0]);
  // Each bot's working line is one line until its chevron opens it: then its steps and the reply so far
  // show as they come in. Remembered per bot while the app is open, so a bot you watch stays open.
  const [watching, setWatching] = useState<Record<string, boolean>>({});
  const watch = (id: string) => {
    const open = !watching[id];
    setWatching((all) => ({ ...all, [id]: open }));
    // Follow it from here, so what streams in next stays in view.
    if (open) requestAnimationFrame(() => props.endRef.current?.scrollIntoView({ block: "end" }));
  };
  const person = (id: string) => props.participants.find((participant) => participant.id === id) ?? { id, display_name: id, look: legacyAppearance(id) };
  const capsule = props.callSlot.live && props.callSlot.look === "capsule";
  // One round button: the mic while the box is empty, Send once it has something.
  const round = composerButton({ hasContent: props.draft.text.trim() !== "" || props.draft.files.length > 0, canCall: !!props.call, live: props.callSlot.live, look: props.callSlot.look });
  const pillCall = props.callSlot.live && props.callSlot.look === "pill";
  const asking = (id: string) => props.approvals.some((card) => card.id === id);
  const by = (id: string, live = false) => {
    const who = person(id);
    return <div className="ph-by" style={{ "--agent-color": who.look.color } as CSSProperties}><Avatar seed={who.look.seed} color={who.look.color} size="sm" working={live && !asking(id)} /><span>{who.display_name}</span></div>;
  };
  return (
    <>
      <header className="ph-nav" inert={props.covered}>
        <button type="button" className="ph-icon ph-nav-back" aria-label="Back to Threads" onClick={props.onBack}><ChevronLeft size={26} /></button>
        {/* Tap the title for project and machine, like the model picker in the ChatGPT app. */}
        {/* During a Top bar call the capsule takes the project line's place; its buttons can't sit inside the title button. */}
        {capsule ? (
          <div className="ph-nav-title ph-has-capsule">
            <button type="button" className="ph-nav-title-tap" aria-label={`${props.draftThread ? "New thread" : props.title}. ${props.project} on ${props.machine}. Change where this runs`} onClick={() => props.onSheet("where")}>
              <h2>{props.draftThread ? "New thread" : props.title}</h2>
            </button>
            {props.callCapsule}
          </div>
        ) : <button type="button" className="ph-nav-title" aria-label={`${props.draftThread ? "New thread" : props.title}. ${props.project} on ${props.machine}. Change where this runs`} onClick={() => props.onSheet("where")}>
          <h2>{props.draftThread ? "New thread" : props.title}</h2>
          <p ref={contextRef} className="ph-context">
            {props.started ? <Lock size={11} /> : props.hostIcon}
            <span className="ph-context-project">{props.project}</span>
            {machineFits && <span className="ph-context-machine">· {props.machine}</span>}
            <ChevronDown size={12} />
          </p>
        </button>}
        {!crew && props.participants.length > 0 && (
          <button type="button" className="ph-cluster" aria-label={`Show the bots: ${props.participants.map((p) => p.display_name).join(", ")}`} onClick={() => { inputRef.current?.blur(); props.onCrew(false); }}>
            {props.participants.slice(0, 3).map((participant) => (
              <Avatar key={participant.id} seed={participant.look.seed} color={participant.look.color} size="sm" working={participant.id in props.working && !asking(participant.id)} />
            ))}
            {props.participants.length > 3 && <b>+{props.participants.length - 3}</b>}
          </button>
        )}
        {props.draftThread
          ? <span className="ph-nav-spacer" />
          : <button type="button" className="ph-icon" aria-label="Thread actions" onClick={props.onMenu}><More size={20} /></button>}
      </header>
      {/* The thread's bots, pinned under the title: tap to @tag, hold or pull down for details. Folds into the title bar, and while the keyboard is up. */}
      {props.participants.length > 0 && (
        <div className={`ph-crew${crew ? "" : " shut"}`} inert={props.covered || !crew} aria-hidden={!crew}>
          <div className="ph-crew-row" role="group" aria-label="Bots in this thread">
            {props.participants.length > 1 && (
              <button type="button" className={`ph-crew-pill${everyone ? " to" : ""}`} aria-label={everyone ? "Everyone. Answers your next message" : "Tag everyone"} onClick={() => tag("all")}>
                <span className="ph-crew-chip"><span className="ph-mention-all" aria-hidden="true">@</span>Everyone</span>
              </button>
            )}
            {props.participants.map((participant) => {
              const next = !everyone && props.toIds?.includes(participant.id);
              const live = participant.id in props.working;
              const meter = props.meters[participant.id];
              const left = meter?.context ?? null;
              return (
                <button key={participant.id} type="button" className={`ph-crew-pill${next ? " to" : ""}${asking(participant.id) ? " asking" : ""}${pill.pull?.id === participant.id ? " pulling" : ""}`} style={{ "--who": participant.look.color, "--pull": `${pill.pull?.id === participant.id ? pill.pull.y : 0}px` } as CSSProperties}
                  aria-label={`${participant.display_name}${asking(participant.id) ? ", waiting on you" : live ? ", working" : next ? ", answers your next message" : ""}${left !== null ? `, ${percent(left)}% context left` : ""}${meter?.planLow ? ", plan nearly used up" : ""}. Tap to tag. Hold or pull down for details and settings`}
                  {...pill.bind(participant.id, () => props.onBot(participant.id), () => tag(participant.id))}>
                  <span className="ph-crew-chip">
                    <span className="ph-crew-face">
                      <Avatar seed={participant.look.seed} color={participant.look.color} size="sm" working={live && !asking(participant.id)} />
                      {meter?.planLow && <i className="ph-crew-plan" />}
                    </span>
                    <span className="ph-crew-name">
                      {participant.display_name}
                      {left !== null && <i className={`ph-crew-meter${meter.low ? " low" : ""}`} style={{ "--left": `${percent(left)}%` } as CSSProperties} />}
                    </span>
                  </span>
                  <i className="ph-crew-grab" aria-hidden="true" />
                </button>
              );
            })}
          </div>
          <button type="button" className="ph-icon ph-crew-fold" aria-label="Fold the bots into the title bar" onClick={() => props.onCrew(true)}><ChevronUp size={18} /></button>
        </div>
      )}
      {/* Pinned for every model, folded to one line; a pin from a message jumps to it. */}
      {props.pins.length > 0 && (
        <details className="pins ph-pins" aria-label="Pinned for every model" inert={props.covered}>
          <summary className="pins-label">Pinned <span>({props.pins.length})</span></summary>
          <div className="pins-list">
            {props.pins.map((pin, index) => <div className="pin" key={pin}>
              {pinSource(pin) !== null
                ? <button type="button" className="pin-text pin-jump" title={pinText(pin)} onClick={() => chatRef.current?.querySelector<HTMLElement>(`[data-seq="${pinSource(pin)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>{pinText(pin)}</button>
                : <span className="pin-text" title={pin}>{pin}</span>}
              <button type="button" className="icon small" aria-label={`Unpin ${pinText(pin)}`} disabled={props.pinning} onClick={() => props.onUnpin(index)}>×</button>
            </div>)}
          </div>
        </details>
      )}
      <main ref={chatRef} className="ph-content ph-chat" inert={props.covered} onScroll={(event) => { const box = event.currentTarget; props.onScrolled(box.scrollHeight - box.scrollTop - box.clientHeight < 80); }}>
        {props.fork && <p className="ph-banner">{forkLine(props.fork, props.messages.length, props.approvalStays)}</p>}
        {!paused && props.link.mismatch && (
          <div className="ph-banner warn" role="status">
            <strong>Different builds</strong>
            <p>{props.link.mismatch}</p>
          </div>
        )}
        {paused && (
          <div className={`ph-banner${props.link.problem ? " bad" : ""}`} role="status">
            <strong>{props.link.problem ? `${props.machine} can't connect` : `${props.machine} ${props.link.status === "offline" ? "can’t be reached" : "is connecting"}`}</strong>
            <p>{downLine(props.link).replace(/\.$/, "")}. Nothing is queued, and your text stays here.</p>
            <div className="ph-banner-actions">
              {!props.link.problem && <button type="button" onClick={props.onRetry}>Retry now</button>}
              {props.kind === "mac" && props.other && <button type="button" onClick={() => props.onOpenOther(props.other!.id)}>Open {props.other.name} thread</button>}
            </div>
          </div>
        )}
        {props.messages.length === 0 && working.length === 0 && !paused && (
          <div className="ph-empty">
            <MessageSquare size={30} />
            <h3>What are we working on?</h3>
            <p>{props.project} · {props.machine}{props.path && <><br />{props.path}</>}</p>
          </div>
        )}
        {/* Each message, then its actions under it: a bot's at the left, yours at the right, as on the desktop. */}
        {props.messages.map((message) => message.speaker.kind === "human" ? (
          <section key={message.seq} className="ph-said mine" data-seq={message.seq}>
            <div className="ph-msg human"><p>{splitTldr(message.text).text}</p></div>
            {actionsFor(message, splitTldr(message.text).text)}
          </section>
        ) : (
          <section key={message.seq} className="ph-said" data-seq={message.seq}>
            <div className="ph-msg">
              {by(message.speaker.id)}
              <div className="ph-md"><Markdown text={message.text} onOpen={(target) => { if (/^https?:/i.test(target)) window.open(target, "_blank", "noopener"); }} fence={(code) => (code.language === CARD_LANGUAGE
                ? <ThreadCard source={code.text} seq={message.seq} author={message.speaker.kind === "bot" ? person(message.speaker.id).display_name : "Human"} versions={versions} answers={null} readOnly onOpen={(target) => { if (/^https?:/i.test(target)) window.open(target, "_blank", "noopener"); }} />
                : undefined)} /></div>
              {(() => {
                const saved = message.speaker.kind === "bot" ? savedEntry(props.stepsIndex, message.seq) : null;
                return saved ? <SavedSteps key={`${props.paneId}:${message.seq}`} count={saved.count} cached={props.loadedSteps.get(message.seq) ?? null} load={() => props.loadSteps(message.seq)} /> : null;
              })()}
            </div>
            {actionsFor(message, message.text)}
          </section>
        ))}
        {/* Cut off mid-reply: what it had written stays, dimmed, until its reply lands, even after a reload. */}
        {cut.map(([id, part]) => (
          <section key={`c-${id}`} className="ph-msg ph-was">
            {by(id)}
            {part.text && <div className="ph-md"><Markdown text={part.text} onOpen={() => {}} /></div>}
          </section>
        ))}
        {lost.length > 0 && <p className="ph-cut" role="status">{cutLine(lost.map((id) => person(id).display_name), props.machine)}</p>}
        {ended.length > 0 && <p className="ph-cut" role="status">{endedLine(ended.map((id) => person(id).display_name))}</p>}
        {/* Each bot's turn: one line with what it is doing and a Stop. Its chevron opens the steps and the reply so far. */}
        {working.map(([id, turn]) => {
          const name = person(id).display_name;
          const open = Boolean(watching[id]);
          const words = toolLine(turnWords(turn, asking(id), props.plan));
          // "Null is writing…", but a named step reads as itself: "Running: npm test".
          const doing = /^(Thinking|Writing|Working|Planning|Waiting for you)$/.test(words) ? `${name} is ${words.toLowerCase()}…` : words;
          const shown = turn.steps.slice(-MAX_STEPS_SHOWN);
          const earlier = turn.steps.length - shown.length;
          const stepCount = turn.work.structured ? turn.work.steps.length : turn.steps.length;
          return (
            <section key={`w-${id}`} className={`ph-msg ph-live${open ? " open" : ""}`} aria-busy="true">
              {by(id, true)}
              <div className={`ph-working${asking(id) ? " asking" : ""}`}>
                <button type="button" className="ph-working-toggle" aria-expanded={open} aria-controls={`ph-progress-${id}`}
                  aria-label={`${name}: ${doing.replace(/…$/, "")}. ${open ? "Hide" : "Show"} progress${stepCount > 0 ? `, ${stepCount === 1 ? "1 step" : `${stepCount} steps`}` : ""}`}
                  onClick={() => watch(id)}>
                  <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>
                  <span className="ph-grow ph-ellipsis" role="status">{doing}</span>
                  <span className="ph-time">{elapsed(Math.max(0, now - turn.startedAt))}</span>
                  <span className="ph-working-chevron" aria-hidden="true"><ChevronDown size={16} /></span>
                </button>
                {!paused && <button type="button" className="ph-stop" aria-label={`Stop ${name}`} onClick={() => props.onStop(id)}>Stop</button>}
              </div>
              {open && (
                <div id={`ph-progress-${id}`} className="ph-progress">
                  {turn.work.structured && <WorkSteps turn={turn.work} live maxShown={MAX_STEPS_SHOWN} />}
                  {!turn.work.structured && turn.steps.length > 0 && (
                    <ol className="ph-steps" aria-label={`${name}'s steps so far`}>
                      {earlier > 0 && <li className="ph-step done">{earlier === 1 ? "1 earlier step" : `${earlier} earlier steps`}</li>}
                      {shown.map((step, i) => (
                        <li key={turn.steps.length - shown.length + i} className={`ph-step${i === shown.length - 1 && turn.phase === "tool" ? " now" : " done"}`}>{toolLine(step)}</li>
                      ))}
                    </ol>
                  )}
                  {turn.text
                    ? <div className="ph-md ph-draft"><Markdown text={turn.text} onOpen={(target) => { if (/^https?:/i.test(target)) window.open(target, "_blank", "noopener"); }} fence={(code) => (code.language === CARD_LANGUAGE ? <PreparingCard author={name} /> : undefined)} /></div>
                    : turn.steps.length === 0 && !turn.work.structured && <p className="ph-progress-none">Nothing to show yet. Steps and the reply appear here as {name} works.</p>}
                </div>
              )}
            </section>
          );
        })}
        {props.approvals.map((card) => (
          <div key={card.request} className="ph-approval">
            <ApprovalCard action={card.action.kind === "tool" ? { ...card.action, title: toolLine(card.action.title) } : card.action} request={card.request} by={card.id} name={person(card.id).display_name} hostName={approvalWhere(props.machine, props.path, props.kind)} disabled={paused} onDecide={(approve, always) => props.onDecide(card.request, approve, always)} />
          </div>
        ))}
        {/* Sent while a bot was mid-reply: it waits here, on the phone, and goes when that bot finishes. */}
        {props.queued.map((item) => (
          <section key={`q-${item.id}`} className={`ph-queued${item.held ? " held" : ""}`} aria-label={`${item.line}: ${item.text}`}>
            <div className="ph-msg human"><p>{item.text}</p></div>
            {props.steerAsk === item.id ? (
              <div ref={steerRef} className="ph-queued-ask" role="alertdialog" aria-label="Steer now?">
                <p><strong>Steer now stops {item.who} mid-reply.</strong> {item.who.includes(" and ") ? "What they were doing may be left half-done. Your message goes as soon as they stop." : "What it was doing may be left half-done. Your message goes as soon as it stops."}</p>
                <div className="ph-queued-actions">
                  <button type="button" className="ph-queued-go" onClick={() => props.onSteer(item.id)}>Steer now</button>
                  <button type="button" onClick={() => props.onSteerAsk(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="ph-queued-meta">
                <span className="ph-queued-line" role="status">{item.line}</span>
                <span className="ph-queued-actions">
                  {item.steerable && !paused && <button type="button" onClick={() => props.onSteerAsk(item.id)}>Steer now</button>}
                  {item.held && !paused && <button type="button" onClick={props.onResume}>Resume</button>}
                  <button type="button" aria-label={`Edit queued message: ${item.text}`} onClick={() => props.onUnqueue(item.id)}>Edit</button>
                  <button type="button" className="ph-queued-x" aria-label={`Remove queued message: ${item.text}`} onClick={() => props.onRemoveQueued(item.id)}><X size={15} /></button>
                </span>
              </div>
            )}
          </section>
        ))}
        <div ref={props.endRef} />
      </main>
      {/* Text picked inside one message: the desktop's Add to chat and More details, clear of iPhone's own menu. */}
      {props.actions && <PickedText key={props.paneId} chat={chatRef} covered={props.covered} canExplain={!paused && props.participants.length > 0}
        onAdd={(seq, text) => {
          const message = props.messages.find((m) => m.seq === seq);
          if (!message) return;
          props.actions?.onQuote(message, text);
          inputRef.current?.focus();
        }}
        onExplain={(seq, text) => {
          const message = props.messages.find((m) => m.seq === seq);
          if (message) props.actions?.onExplain(message, text);
        }} />}
      <form className={`ph-composer${props.plan ? " plan" : ""}${props.tldr ? " tldr" : ""}`} inert={props.covered} onSubmit={(event) => {
        event.preventDefault();
        if (props.tldr && props.gate.enabled && !props.sending && !props.attaching) wiggle(inputRef.current?.parentElement ?? null);
        props.onSend();
      }}>
        {props.quotes.length > 0 && (
          <div className="quote-preview ph-quotes">
            <div className="quote-preview-head">
              <span className="quote-count">{props.quotes.length === 1 ? "1 quote" : `${props.quotes.length} quotes`}</span>
              <span className="quote-head-actions">
                <span className="pane-menu-wrap hand-off">
                  {/* These keep the keyboard as it is: the box keeps focus while you pick. */}
                  <button type="button" className="ghost small" aria-haspopup="menu" aria-expanded={handOffOpen} onPointerDown={(event) => event.preventDefault()} onClick={() => setHandOffOpen((open) => !open)}>
                    {handOffLabel(quoteTo, (id) => person(id).display_name)} ▾
                  </button>
                  {handOffOpen && <span className="pane-menu hand-off-menu" role="menu">
                    {handOffChoices(quoteTo, props.participants.map((p) => ({ id: p.id, name: p.display_name }))).map((choice) => (
                      <button type="button" role="menuitem" key={choice.to} onPointerDown={(event) => event.preventDefault()} onClick={() => { props.onQuotes(props.quotes.map((quote) => ({ ...quote, to: choice.to }))); setHandOffOpen(false); }}>{choice.label}</button>
                    ))}
                  </span>}
                </span>
                {props.quotes.length > 1 && <button type="button" className="quote-clear-all" onPointerDown={(event) => event.preventDefault()} onClick={() => props.onQuotes([])}>Clear all</button>}
              </span>
            </div>
            <div className="quote-preview-list">{props.quotes.map((item, index) => (
              <div className="quote-preview-row" key={`${item.id}:${item.name}:${index}`}>
                <span className="quote-author" title={item.id ? item.name : "You"}>{item.id ? item.name : "You"}</span>
                <blockquote>{item.text}</blockquote>
                <button type="button" className="quote-cancel" aria-label={`Remove quote ${index + 1}`} onPointerDown={(event) => event.preventDefault()} onClick={() => props.onQuotes(props.quotes.filter((_, i) => i !== index))}>×</button>
              </div>
            ))}</div>
          </div>
        )}
        {props.draft.files.length > 0 && (
          <div className="ph-chips">
            {props.draft.files.map((file) => (
              <span key={file.id} className="ph-chip"><Paperclip size={13} />{file.name}<button type="button" aria-label={`Remove ${file.name}`} onClick={() => props.onRemoveFile(file.id)}><X size={14} /></button></span>
            ))}
          </div>
        )}
        {props.form}
        {props.plan && <button type="button" className="plan-chip ph-plan" aria-label="Plan is on. Turn it off" onClick={props.onStopPlanning}><span aria-hidden="true">◇</span><span className="plan-chip-label">Plan</span><span className="plan-chip-x" aria-hidden="true">✕</span></button>}
        {picking && picking.picks.length > 0 && (
          <div className="ph-mentions" role="listbox" aria-label="Mention a bot">
            {picking.picks.map((pick) => {
              const who = pick.id === "all" ? null : person(pick.id);
              return (
                // Keep the keyboard up: the box keeps focus while you pick.
                <button key={pick.id} type="button" role="option" aria-selected="false" className="ph-mention" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(pick.handle)}>
                  {who ? <Avatar seed={who.look.seed} color={who.look.color} size="sm" /> : <span className="ph-mention-all" aria-hidden="true">@</span>}
                  <span>{who ? who.display_name : "Everyone"}</span>
                  <small>{pick.label}</small>
                </button>
              );
            })}
          </div>
        )}
        {props.callStrip}
        {/* One row, as in Messages: + for files and tools, then the message box. */}
        <div className="ph-compose-row">
          <button type="button" className="ph-add" aria-label={props.draft.files.length > 0 ? `Add files or tools. ${props.draft.files.length} attached` : "Add files or tools"} onClick={props.onOpenComposer}>
            <Plus size={22} />
            {props.draft.files.length > 0 && <b className="ph-count">{props.draft.files.length}</b>}
          </button>
          <div className={`ph-input${pillCall ? " ph-in-call" : ""}`}>
            <textarea ref={inputRef} aria-label={props.to ? `Message ${props.to}` : "Message this thread"} rows={1} value={props.draft.text}
              placeholder={props.callSlot.live ? (pillCall ? props.callSlot.hint : "Speak or type…") : props.quotes.length ? "e.g. Check this against the tests and say what breaks" : props.plan ? "Plan with the bots — nothing gets changed…" : props.queueing && props.to ? `Queue for ${props.to}…` : props.tldr ? (props.to ? `TL;DR to ${props.to}…` : "TL;DR: short answers…") : props.to ? `Message ${props.to}…` : "Message the group…"}
              onChange={(event) => { props.onDraft(event.target.value); setCaret(event.target.selectionStart); }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onFocus={(event) => { setCaret(event.currentTarget.selectionStart); setTyping(true); }}
              onBlur={() => { setCaret(null); setTyping(false); }} />
            <button type="button" className="tldr-pill" aria-pressed={props.tldr} aria-label="TL;DR mode"
              // Keep the keyboard up when it is: the box keeps focus.
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onTldr}><span aria-hidden="true">TL;</span><span aria-hidden="true">DR</span></button>
            {props.call?.(round.mic)}
            {round.send && <button type="submit" className="ph-send" aria-label={props.sending ? `Sending to ${props.machine}` : props.attaching ? "Attaching a file" : props.queueing && props.to ? `Queue for ${props.to}. It goes when ${props.to} finishes` : `Send to ${props.machine}`} disabled={!props.gate.enabled || props.sending || props.attaching}><ArrowUp size={21} /></button>}
          </div>
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

function WorkSheet({ rows, links, workspaces, project, stays, machineIcon, onPick, onBrowse, onProject }: {
  rows: ReturnType<typeof workInRows>; links: LinkView[]; workspaces: Workspace[]; project: string; stays: string | null;
  machineIcon(hostId: string, size?: number): ReactNode; onPick(workspace: Workspace): void; onBrowse(hostId: string): void; onProject(): void;
}) {
  return (
    <div className="ph-location-options">
      <div className="ph-group ph-location-group">
        <div className="ph-location-label">Project</div>
        <button type="button" className="ph-location-choice ph-location-project" onClick={onProject}>
          <span className="ph-location-badge"><Folder size={20} /></span>
          <span className="ph-location-copy"><strong>{project}</strong><small>Change project</small></span>
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="ph-group ph-location-group">
        <div className="ph-location-label">Machine</div>
        <div className="ph-location-machine-list">{rows.map((row) => {
          const link = links.find((item) => item.id === row.hostId);
          const workspace = row.workspaceId ? workspaces.find((item) => item.id === row.workspaceId) ?? null : null;
          const status = link?.status === "online" ? "Online" : link ? downLine(link) : "Unavailable";
          return (
            <button key={`${row.hostId}:${row.path}`} type="button" aria-current={row.current ? "true" : undefined} className={`ph-location-choice ph-location-machine${row.current ? " current" : ""}`} disabled={row.offline && !row.current} onClick={() => workspace ? onPick(workspace) : onBrowse(row.hostId)}>
              <span className="ph-location-machine-icon">{machineIcon(row.hostId, 20)}</span>
              <span className="ph-location-copy"><strong>{link?.name ?? row.hostId}</strong><small>{row.path ? homeShort(row.path) : "No copy yet · choose a folder"}</small><small className={`ph-location-status${row.offline ? " offline" : ""}`}>{status}</small></span>
              {row.current ? <CheckCircle size={22} /> : <ChevronRight size={18} />}
            </button>
          );
        })}</div>
      </div>
      {stays && <p className="ph-location-note ph-location-lock"><Lock size={14} /> <span>This thread stays on {stays}. Choose another to start a new thread or fork.</span></p>}
      <p className="ph-location-note">Files stay on each machine.</p>
    </div>
  );
}

/** How a new machine is reached: its QR code, or an address and token typed in. */
type AddHow = "qr" | "address";

function Machines({ machines, links, routes, covered, machineIcon, missing, confirm, pairing, scan, autoScan, onAutoScan, incoming, onIncomingHandled, onIncomingFailed, reserve, adopt, giveBack, onAdd, onPair, onEdit, onUnpair, onConfirm, onRetry, onError }: {
  machines: Machine[]; links: LinkView[]; routes: Record<string, Route | null>; covered: boolean; machineIcon(hostId: string, size?: number): ReactNode; missing: string[]; confirm: string | null;
  /** The native plugin can pair from a QR code. */
  pairing: boolean;
  /** The camera scanner, when there is one. */
  scan: (() => Promise<string>) | null;
  /** Open the camera now, as the first thing: no machine is saved yet. */
  autoScan: boolean;
  onAutoScan(): void;
  /** A pairing link opened from outside this screen. Handed to pairWith as a Mac. */
  incoming: { id: number; url: string; kind: "mac"; adding: true } | null;
  /** The link has been handed to pairWith, so a later visit must not pair it again. */
  onIncomingHandled(): void;
  onIncomingFailed(): void;
  /** Camera and paste take the same slot as a link. False leaves the open sheet where it is. */
  reserve(link: string): boolean;
  /** The open camera read a link. True only when that scan still holds the slot. */
  adopt(link: string): boolean;
  /** The slot was taken, then the link was rejected before a sheet opened. */
  giveBack(link: string): void;
  onAdd(machine: DirectMachine): void; onPair(request: { link: string; kind: MachineKind; id: string; name: string }): void;
  onEdit(id: string, machine: Machine): void; onUnpair(id: string): void; onConfirm(id: string | null): void; onRetry(id: string): void; onError(message: string): void;
}) {
  const hasMac = machines.some((machine) => machine.kind === "mac");
  const blank = (kind: MachineKind) => ({ name: "", url: "", token: "", kind, id: kind === "server" ? missing[0] ?? "" : "" });
  const [form, setForm] = useState(() => blank(hasMac ? "server" : "mac"));
  const [how, setHow] = useState<AddHow>(defaultAddHow(pairing));
  const [pasted, setPasted] = useState("");
  const [adding, setAdding] = useState(machines.length === 0);
  /** The machine being edited. Its form takes the place of its card. */
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState(() => blank("mac"));
  const pairWith = (link: string, over?: { kind: MachineKind }, held = false): boolean => {
    const trimmed = link.trim();
    // A link already holds the slot. Camera and paste take it here, or leave the open sheet alone.
    if (!held && !reserve(trimmed)) return false;
    const kind = over?.kind ?? form.kind;
    try {
      const preview = parsePairingLink(trimmed);
      const name = (over ? "" : form.name.trim()) || preview.name;
      const id = kind === "mac" ? "local" : form.id.trim();
      // Checked now, so a bad name or id doesn't surface only after the machine approved.
      withPairedMachine(machines, { id, name, kind, transport: "iroh", hostEndpointId: preview.host, addrs: preview.addrs, pairedAt: 0 });
      onPair({ link: trimmed, kind, id, name });
      setAdding(false);
      setPasted("");
      return true;
    } catch (error) {
      if (!held) giveBack(trimmed);
      onError(words(error));
      return false;
    }
  };
  // A link from any screen. Kind is taken from the link, not from whatever form was open.
  useEffect(() => {
    if (!incoming) return;
    const link = incoming;
    onIncomingHandled();
    setEditing(null);
    setHow("qr");
    setForm(blank(link.kind));
    if (link.adding) setAdding(true);
    if (!pairWith(link.url, { kind: link.kind }, true)) onIncomingFailed();
  }, [incoming]);
  return (
    <main className="ph-content" inert={covered}>
      <h2>Machines</h2>
      <p className="ph-intro">This phone connects to each machine itself. Servers stay reachable when your Mac sleeps.</p>
      {machines.map((machine) => {
        const link = links.find((item) => item.id === machine.id);
        const paired = isPaired(machine);
        if (editing === machine.id) return (
          <form key={machine.id} className="ph-group ph-padded ph-form" onSubmit={(event) => {
            event.preventDefault();
            try {
              const id = machine.kind === "mac" ? "local" : edit.id.trim();
              onEdit(machine.id, paired ? { ...machine, id, name: edit.name } : { id, name: edit.name, kind: machine.kind, url: edit.url, token: edit.token });
              setEditing(null);
            } catch (error) { onError(words(error)); }
          }}>
            <h3>{machineIcon(machine.id, 18)} Edit {machine.name}</h3>
            <label className="ph-label">Name<input value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} required autoCapitalize="words" /></label>
            {machine.kind === "server" && <label className="ph-label">Id<input value={edit.id} onChange={(event) => setEdit({ ...edit, id: event.target.value })} required autoCapitalize="off" autoCorrect="off" spellCheck={false} /><small>{missing.length > 0 ? `The id your Mac uses for it: ${missing.join(" or ")}` : "The id your Mac uses for this server"}</small></label>}
            {!paired && <label className="ph-label">Address<input value={edit.url} onChange={(event) => setEdit({ ...edit, url: event.target.value })} required inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>}
            {!paired && <label className="ph-label">Daemon token<input type="password" value={edit.token} onChange={(event) => setEdit({ ...edit, token: event.target.value.trim() })} placeholder="Leave empty to keep the saved token" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} /><small>Paste a new token only if it changed.</small></label>}
            <button type="submit" className="primary ph-wide">Save</button>
            <button type="button" className="ph-plain ph-wide" onClick={() => setEditing(null)}>Cancel</button>
          </form>
        );
        const route = paired && link?.status === "online" ? routes[machine.id] : null;
        const state = !link ? "Connecting…" : link.status === "online" ? route === "direct" ? "Connected · Direct" : route === "relayed" ? "Connected · Relayed" : "Connected" : link.problem ? "Can't connect" : link.status === "offline" ? "Offline" : "Connecting…";
        return (
          <div key={machine.id} className={`ph-group ph-padded${link?.problem ? " bad" : ""}`}>
            <h3>{machineIcon(machine.id, 18)} {machine.name}</h3>
            <p className="ph-muted"><i className={`ph-dot${link?.status === "online" ? " on" : link?.status === "offline" ? " off" : ""}`} />{state} · paired with this phone</p>
            {link && link.status !== "online" && link.status !== "connecting" && <p className={link.problem ? "ph-red" : "ph-muted"}>{downLine(link)}</p>}
            <p className="ph-path">{paired ? `Paired by QR code · ${machine.hostEndpointId.slice(0, 12)}…` : machine.url}{machine.kind === "server" ? ` · id ${machine.id}` : ""}</p>
            {link && link.status === "offline" && !link.problem && <button type="button" className="ph-wide" onClick={() => onRetry(machine.id)}>Retry now</button>}
            {confirm === machine.id
              ? <>
                <p className="ph-muted">Its threads stay on {machine.name}. You can pair it again later.</p>
                <button type="button" className="danger ph-wide" onClick={() => onUnpair(machine.id)}>Unpair {machine.name}</button>
                <button type="button" className="ph-plain ph-wide" onClick={() => onConfirm(null)}>Cancel</button>
              </>
              : <>
                <button type="button" className="ph-wide" onClick={() => { setEdit({ name: machine.name, url: paired ? "" : machine.url, token: "", kind: machine.kind, id: machine.kind === "server" ? machine.id : "" }); setEditing(machine.id); onConfirm(null); }}>Edit…</button>
                <button type="button" className="ph-plain ph-wide" onClick={() => onConfirm(machine.id)}>Unpair…</button>
              </>}
          </div>
        );
      })}
      {missing.length > 0 && <p className="ph-intro">Your Mac's threads also use {missing.join(", ")}. Pair each one so those threads work here too.</p>}
      {!adding && !editing && <button type="button" className="primary ph-wide" onClick={() => { setForm(blank(hasMac ? "server" : "mac")); setAdding(true); }}>Add a machine…</button>}
      {adding && (
        <form className="ph-group ph-padded ph-form" onSubmit={(event) => {
          event.preventDefault();
          if (how === "qr") { pairWith(pasted); return; }
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
          <AddHowPicker pairing={pairing} how={how} onHow={setHow} />
          <label className="ph-label">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={how === "qr" ? "From the code" : form.kind === "mac" ? "Tyler's MacBook" : "Apex-Terminal"} required={how === "address"} autoCapitalize="words" /></label>
          {form.kind === "server" && <label className="ph-label">Id<input value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} placeholder={missing[0] ?? "h-…"} required autoCapitalize="off" autoCorrect="off" spellCheck={false} /><small>{missing.length > 0 ? `The id your Mac uses for it: ${missing.join(" or ")}` : "The id your Mac uses for this server"}</small></label>}
          {how === "qr" ? <>
            <p className="ph-muted">{PAIR_MACHINE_HINT} On a server, run <code>apex-daemon pair</code>.</p>
            {scan && <ScanCodeButton scan={scan} reserve={reserve} adopt={adopt} giveBack={giveBack} onCode={(text) => pairWith(text, undefined, true)} onError={onError} auto={autoScan && !incoming} onAuto={onAutoScan} />}
            <label className="ph-label">Or paste the pairing link<input value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="apexdeck://pair?p=…" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
            <button type="submit" className={scan ? "ph-wide" : "primary ph-wide"} disabled={!pasted.trim()}>Pair with link</button>
          </> : <>
            <label className="ph-label">Address<input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder={form.kind === "mac" ? "ws://your-Mac's-address:7421" : "ws://server-address:7420"} required inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
            <label className="ph-label">Daemon token<input type="password" value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value.trim() })} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} required /><small>Paste only the token. Spaces and line breaks are removed.</small></label>
            <button type="submit" className="primary ph-wide">Pair {form.kind === "mac" ? "Mac" : "server"}</button>
          </>}
          {machines.length > 0 && <button type="button" className="ph-plain ph-wide" onClick={() => setAdding(false)}>Cancel</button>}
        </form>
      )}
      <p className="ph-foot">{how === "qr" ? "Pairing keys stay in this phone's Keychain." : "The token works like a password. It stays on this phone."}</p>
    </main>
  );
}

function SideTab({ tab, link, host, hosts, terminalCwd, agents, bots, covered, library, assistantProjects, assistantRegistryErrors, terminalSwitcherOpen, onTerminalSwitcherOpened, terminalResumeSignal, onTerminalWaiting, terminalHomeSignal, onTerminalViewing, onAssistant, onShow, personal, onPersonal }: { tab: Tab; link: LinkView | null; host: PhoneHost | null; hosts: PhoneHost[]; terminalCwd: string | null; agents: string[]; bots: (Person & { tool: string; working: string | null; cutOff: string | null })[]; covered: boolean; library: ReactNode; assistantProjects: { workspace: Workspace; link: LinkView | null; allowed: boolean }[]; assistantRegistryErrors: Record<string, string>; terminalSwitcherOpen: boolean; onTerminalSwitcherOpened(): void; terminalResumeSignal: number; onTerminalWaiting(waiting: boolean): void; terminalHomeSignal: number; onTerminalViewing(viewing: boolean): void; onAssistant(workspaceId: string): void; onShow(): void; personal: PersonalLane | null; onPersonal(): void }) {
  useEffect(() => { if (tab === "agents") onShow(); }, [tab, link?.id, link?.status]);
  // The Library lists every paired machine itself, so it doesn't follow one machine or wait on the Mac.
  if (tab === "library") return <main className="ph-content" inert={covered}>{library}</main>;
  const offline = !link || link.status !== "online";
  return (
    <main className="ph-content" inert={covered}>
      {/* Code names its project and machine itself, so only Agents says which machine it follows. */}
      {link && tab === "agents" && <p className="ph-intro"><i className={`ph-dot${link.status === "online" ? " on" : link.status === "offline" ? " off" : ""}`} />Follows {link.name}</p>}
      {!link && <div className="ph-empty"><h3>Pair a machine first</h3><p>Open Settings → Machines.</p></div>}
      {link && offline && <div className="ph-banner"><strong>{link.name} can't be reached</strong><p>{downLine(link)}</p></div>}
      {tab === "agents" && bots.length > 0 && <>
        <div className="ph-section">Your bots</div>
        <div className="ph-list">{bots.map((bot) => (
          <div key={bot.id} className="ph-srow">
            <Avatar seed={bot.look.seed} color={bot.look.color} working={bot.working !== null} />
            <span className="ph-grow"><strong>{bot.display_name}</strong><small className={bot.working ? "ph-mint" : bot.cutOff ? "ph-amber" : undefined}>{bot.working ? `Working in ${bot.working}` : bot.cutOff ?? bot.tool}</small></span>
          </div>
        ))}</div>
      </>}
      {tab === "agents" && personal && <>
        <div className="ph-section">Your assistant</div>
        <div className="ph-list">{(() => {
          const waiting = personal.assistant?.tasks.filter((task) => task.status === "needsYou" && task.decision?.status === "open").length ?? 0;
          // Tasks that need you, plus delivered notices nobody has seen yet.
          const unseen = personal.assistant?.notices?.filter((notice) => notice.deliveredAt && !notice.seenAt).length ?? 0;
          const needYou = waiting + unseen;
          const usable = !!personal.assistant && !personal.offline;
          const detail = personal.problem ?? (personal.offline ? `${personal.hostName} can't be reached` : !personal.assistant ? `Set it up on ${personal.hostName} from the Mac` : needYou ? `${personal.hostName} · ${needYou} need${needYou === 1 ? "s" : ""} you` : `${personal.hostName} · Open conversation`);
          return <button type="button" className="ph-srow ph-project-assistant" disabled={!usable} onClick={onPersonal}>
            <span className="ph-grow"><strong>{personal.name}</strong><small className={needYou ? "ph-amber" : undefined}>{detail}</small></span>
            {usable && <ChevronRight size={15} />}
          </button>;
        })()}</div>
      </>}
      {tab === "agents" && <>
        <div className="ph-section">Project assistants</div>
        {assistantProjects.length === 0
          ? <p className="ph-list-note">No projects yet. Add one from Threads to set up the assistant.</p>
          : <div className="ph-list">{assistantProjects.map(({ workspace, link: projectLink, allowed }) => {
            const available = projectLink?.status === "online" && allowed;
            const error = assistantRegistryErrors[workspace.id];
            const detail = error ? `Assistant unavailable: ${error}`
              : !projectLink ? "Pair its machine to this phone"
              : projectLink.status !== "online" ? downLine(projectLink)
                : !allowed ? "Needs Full access on its machine" : `${projectLink.name} · Open project assistant`;
            return <button key={workspace.id} type="button" className="ph-srow ph-project-assistant" disabled={!available} onClick={() => onAssistant(workspace.id)}>
              <span className="ph-grow"><strong>{workspace.name}</strong><small>{detail}</small></span>
              {available && <ChevronRight size={15} />}
            </button>;
          })}</div>}
      </>}
      {link && !offline && tab === "agents" && <>
        <div className="ph-section">Installed on {link.name}</div>
        {agents.length === 0
          ? <p className="ph-list-note">No coding agents found.</p>
          : <div className="ph-list">{agents.map((agent) => <div key={agent} className="ph-srow"><span className="ph-grow"><strong>{agent}</strong><small>Ready</small></span></div>)}</div>}
      </>}
      {link && <PhoneTerminal host={host} hosts={hosts} name={link.name} cwd={terminalCwd} hidden={tab !== "code"} openSwitcher={terminalSwitcherOpen} onSwitcherOpened={onTerminalSwitcherOpened} resumeSignal={terminalResumeSignal} onWaitingChange={onTerminalWaiting} homeSignal={terminalHomeSignal} onViewingChange={onTerminalViewing} />}
    </main>
  );
}
