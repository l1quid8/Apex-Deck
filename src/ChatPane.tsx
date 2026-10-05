import { actionChevron, messageTime } from "./messageActions";
import { responsePin, pinSource, pinText, pinsAfterClear } from "./messagePins";
import { ReplyPolicyPicker, REPLY_POLICIES } from "./ReplyPolicyPicker";
import { BotSettings } from "./BotSettings";
import type { AllowedRule, RevertPlan, Speaker, ThreadStatus, ToolServer } from "./types";
import { ArtifactButton, type CodeChoice } from "./ArtifactButton";
import { parseBlocks } from "./markdownText";
import { ModDock, useMods } from "./ModView";
import { modHost } from "./mods/host";
import { ArtifactsPanel, DEFAULT_VIEW, type PanelView } from "./ArtifactsPanel";
import { EMPTY_ARTIFACTS, MAX_SOURCE, addArtifact, addVersion, codeChoices, kindForPath, kindOf, pickVersion, readArtifacts, artifactAutoOpen, upsertFromFile, fromReply, type ArtifactFile } from "./artifacts";
import { parseServerRequests, resolveServerRequests } from "./serverRequests";
import { findServerUrls, isLocalHost, normalizeAddress } from "./previewAddress";
import { failedLine, goBackAlways, goBackAsks, goBackRequest, goBackTitle, initialFiles, saveGoBackAlways, type GoBack, type RevertScope } from "./revertConfirm";
import { saveThreadSteer, steerAnswer, steerAsks, threadSteer, type SteerAnswer, type ThreadSteer } from "./steerConfirm";
import { composerCopy, doingNow, elapsed, headLine, heardFrom, isCommandLine, quietLine, threadStatusOf, type BotProgress } from "./composerStatus";
import { slug } from "./slug";
import { nameForModel, uniqueName } from "./quickAdd";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ComposerMenu, type ComposerMenuHandle } from "./ComposerTools";
import { findTrigger, insertAt } from "./composerMenu";
import { createPortal } from "react-dom";
import { ThreadDetails, type DetailsHost } from "./ThreadDetails";
import type { Backend } from "./backend";
import { providerEnabled, providerForConfig } from "./providers";
import { registerRoom } from "./hub";
import { rememberModel, rememberedModels } from "./modelMemory";
import { AGENT_EFFORTS, AGENT_MODELS, API_EFFORTS, effortLabel, effortsFor, findModel, modelGroups } from "./models";
import { Picker, type PickerGroup } from "./Picker";
import { DeckIcon } from "./DeckIcon";
import { Avatar, type Refills } from "./Avatar";
import { contextLevel, countdown, resetDate, contextLine, isLow, liveWindows, percent, planLevel, planLine, tokenLine, windowLabel, type Levels } from "./battery";
import { usePlans } from "./plans";
import { AGENT_COLORS, createAppearance, legacyAppearance, type AgentAppearance } from "./identicon";
import { afterRound, type Attention, type Signal } from "./attention";
import { ApprovalCard, type MadeChange } from "./ApprovalCard";
import { approvalSignal, approvalSnapshot, cardsByBot, deadlineNote, forgetRoom, openCards, subscribeApprovals } from "./approvals";
import { REMOVED_NOTE_MS, allowedLine, describeRule, removedLine } from "./allowedRules";
import { exportFileName, exportJson, exportMarkdown, type ThreadExport } from "./exportThread";
import { DiffPanel } from "./DiffPanel";
import { nextReviewNumber, reviewDraft, reviewFileNames, reviewPatch, reviewPatches, reviewerRows } from "./review";
import { RichText } from "./RichText";
import { Markdown } from "./Markdown";
import { ParticipantQueues, type ParticipantMessage, type TurnKind } from "./turnQueue";
import { handOffChoices, handOffLabel, quoteFor, quoteLead, replyText, type ReplyQuote } from "./reply";
import { attachedImages, attachmentName, replyImages, withAttachments, type Attachment } from "./attachments";
import { AttachedImages } from "./AttachedImages";
import { loadTldr, saveTldr, splitTldr, wiggle, withTldr } from "./tldr";
import { cardsOutOfView, firstUnseen, isAtBottom, newPill, owners, seenList, seenMark, unseenCount, waitingLine, type CardBox } from "./transcriptPlace";
import { exampleRows, hasMention, recipientLine, showsRecipientLine } from "./recipients";
import { askerOf, hopNotice, letLabel, liveActions, retryFor, stillHere, type NoticeAction } from "./noticeActions";
import { parseComposer, parseQueueEdit, postable, type Command } from "./commands";
import type {
  Access,
  AgentInfo,
  AgentTool,
  Message,
  ModelChoice,
  Pane,
  ParticipantBackend,
  ParticipantConfig,
  RoomEvent,
  RoomOptions,
  TurnPolicy,
  ThreadDiff,
  TokenTotals,
} from "./types";

interface Props {
  pane: Pane;
  /** The workspace folder. Command-line participants run here. */
  cwd: string;
  /** Which coding agents are installed, to enable their presets. */
  agents: AgentInfo[];
  backend: Backend;
  focused: boolean;
  /** The workspace's name, for the details sidebar heading. */
  workspaceName?: string;
  /** What the thread reports to App: the pane head's words, and who is replying or waiting on a card. */
  onStatus?: (paneId: string, status: ThreadStatus) => void;
  /** Save where you stopped reading: the seq of the newest message you saw at the bottom, or -1 after /clear. */
  onSeen?: (paneId: string, seq: number) => void;
  /** Agents only: bumped to open the new agent form. */
  addRequest?: number;
  onActivity: (paneId: string) => void;
  /** Raise or clear (with `null`) this chat's request for attention. */
  onSignal?: (paneId: string, kind: Attention | null, note?: string) => void;
  /** Raise (with the flag) or clear (with `null`) this chat's blocking flag for its open approval cards. */
  onApprovals?: (paneId: string, signal: Signal | null) => void;
  /** The newest local server address a bot mentioned in a finished reply. */
  onServer?: (paneId: string, address: string) => void;
  /** Show a local server in a Preview beside this thread: a link you clicked, or (`auto`) one a bot just named. */
  onPreview?: (address: string, auto: boolean) => void;
  profiles: ParticipantConfig[];
  onProfilesChange: (profiles: ParticipantConfig[]) => void;
  profileMode?: boolean;
  onFork?: (title: string, upto: number | null) => Promise<string>;
  /** Fork or Export chosen in the pane's ⋯ menu; `n` goes up on each choice. */
  menuRequest?: { action: "fork" | "export"; n: number };
  disabledProviders: string[];
  /** Settings › New threads: what a thread never saved before starts with. */
  newThread?: RoomOptions;
  /** Settings › New threads: the access the add-bot form starts at. */
  newBotAccess?: Access;
  /** Settings › Confirm before steering. A thread can override it. */
  confirmSteer?: boolean;
  /** "Always" in the steer prompt turns the setting off everywhere. */
  onConfirmSteer?: (confirm: boolean) => void;
  details?: DetailsHost;
}

/** A line in the transcript from the app. `action` adds Try again or Let them answer. */
type Notice = { key: number; text: string; tone: "info" | "error"; action?: NoticeAction };
/** Where `/compact` cut in: the models see `summary` instead of the messages above it. */
type Summary = { by: string | null; summary: string; upto: number };
/** An agent's context has just dropped to the low mark; shown once under its reply. */
type LowContext = { key: number; id: string; left: number };
type Entry =
  | { kind: "message"; message: Message }
  | { kind: "notice"; notice: Notice }
  | { kind: "summary"; summary: Summary }
  | { kind: "low"; low: LowContext };

function messagesOf(entries: Entry[]): Message[] {
  return entries.flatMap((entry) => entry.kind === "message" ? [entry.message] : []);
}
function compactionOf(entries: Entry[]) {
  const summary = entries.filter((entry) => entry.kind === "summary").at(-1);
  return summary?.kind === "summary" ? { upto: summary.summary.upto, summary: summary.summary.summary } : null;
}

export { slug };

/** Split a command line into arguments, honouring single and double quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
    }
  }
  if (started || current) out.push(current);
  return out;
}

type PresetKey = "claude_code" | "codex" | "gemini" | "grok" | "ollama" | "api" | "command" | "scripted";

interface Preset {
  key: PresetKey;
  label: string;
  /** Every effort level the backend understands. Empty means it has no such setting. */
  efforts: string[];
  /** Set for presets that run a known coding agent. Its models are listed in models.ts. */
  agent?: { tool: AgentTool; detectKey: string; modelNote: string; enforcesAccess: boolean; asksFirst: boolean };
  /** Set for presets that call an HTTP API. */
  api?: { baseUrl: string; autoLoad: boolean };
}

// Model names and effort levels are suggestions. Both pickers also accept
// anything you type, and names you type are remembered on this computer.
export const PRESETS: Preset[] = [
  {
    key: "claude_code",
    label: "Claude Code",
    efforts: AGENT_EFFORTS.claude_code,
    agent: { tool: "claude_code", detectKey: "claude", modelNote: "A short name such as opus follows the newest version. Pick a full name to stay on one version.", enforcesAccess: true, asksFirst: true },
  },
  {
    key: "codex",
    label: "Codex",
    efforts: AGENT_EFFORTS.codex,
    agent: { tool: "codex", detectKey: "codex", modelNote: "Your account may not offer every model; Codex says so in the chat if not.", enforcesAccess: true, asksFirst: true },
  },
  {
    key: "gemini",
    label: "Gemini CLI",
    efforts: AGENT_EFFORTS.gemini,
    agent: { tool: "gemini", detectKey: "gemini", modelNote: "Names are from Google's model list. Gemini CLI says so in the chat if your account cannot use one.", enforcesAccess: false, asksFirst: false },
  },
  {
    key: "grok",
    label: "Grok",
    efforts: AGENT_EFFORTS.grok,
    agent: { tool: "grok", detectKey: "grok", modelNote: "The list follows the models Grok offers your account.", enforcesAccess: true, asksFirst: false },
  },
  { key: "ollama", label: "Ollama (local models)", efforts: API_EFFORTS, api: { baseUrl: "http://localhost:11434/v1", autoLoad: true } },
  { key: "api", label: "Other API (OpenAI-compatible)", efforts: API_EFFORTS, api: { baseUrl: "", autoLoad: false } },
  { key: "command", label: "Custom command", efforts: [] },
  { key: "scripted", label: "Scripted (no model, for testing)", efforts: [] },
];

const AGENT_LABEL: Record<AgentTool, string> = { claude_code: "Claude Code", codex: "Codex", gemini: "Gemini CLI", grok: "Grok" };

interface Draft {
  appearance?: AgentAppearance;
  name: string;
  preset: PresetKey;
  /** Empty means the backend's own default (agent presets only). */
  model: string;
  /** Empty means the backend's own default. */
  effort: string;
  baseUrl: string;
  keyEnv: string;
  command: string;
  persona: string;
  access: Access;
}

/** `access` is the default from settings; a tool that can't ask first gets Read only. */
function emptyDraft(preset: PresetKey, access: Access = "read"): Draft {
  const found = PRESETS.find((p) => p.key === preset);
  const allowed = access === "ask" && !found?.agent?.asksFirst ? "read" : access;
  return { name: "", preset, model: "", effort: "", baseUrl: found?.api?.baseUrl ?? "", keyEnv: "", command: "", persona: "", access: allowed };
}

/** Put an argument back into command-line form, quoting it if it has spaces. */
function quoteArg(arg: string): string {
  if (arg !== "" && !/[\s"']/.test(arg)) return arg;
  return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
}

/** The form values that would recreate `config`, for editing it. */
export function configToDraft(config: ParticipantConfig): Draft {
  const base = { appearance: config.appearance ?? legacyAppearance(config.id), name: config.display_name, persona: config.persona, access: config.access, effort: config.effort ?? "", keyEnv: "", command: "", baseUrl: "", model: "" };
  const b = config.backend;
  if (b.kind === "agent") return { ...base, preset: b.tool, model: b.model ?? "" };
  if (b.kind === "open_ai_compatible") {
    const preset = b.base_url === PRESETS.find((p) => p.key === "ollama")!.api!.baseUrl ? "ollama" : "api";
    return { ...base, preset, baseUrl: b.base_url, model: b.model, keyEnv: b.api_key_env ?? "" };
  }
  if (b.kind === "cli") return { ...base, preset: "command", command: [b.program, ...b.args].map(quoteArg).join(" ") };
  return { ...base, preset: "scripted" };
}

export function draftToConfig(draft: Draft): ParticipantConfig | string {
  const id = slug(draft.name);
  if (!id) return "Give the participant a name.";
  const preset = PRESETS.find((p) => p.key === draft.preset);
  let backend: ParticipantBackend;
  if (preset?.agent) {
    backend = { kind: "agent", tool: preset.agent.tool, model: draft.model.trim() || null };
  } else if (preset?.api) {
    if (!draft.baseUrl.trim()) return "Enter the API base URL.";
    if (!draft.model.trim()) return "Pick or type a model name.";
    backend = { kind: "open_ai_compatible", base_url: draft.baseUrl.trim(), model: draft.model.trim(), api_key_env: draft.keyEnv.trim() || null };
  } else if (draft.preset === "command") {
    const [program, ...args] = splitArgs(draft.command);
    if (!program) return "Enter the command to run.";
    backend = { kind: "cli", program, args };
  } else {
    backend = { kind: "scripted", lines: ["Hello from a scripted participant.", "I only have a few lines.", "[pass]"] };
  }
  // A model with no effort setting must not be sent one.
  const levels = preset?.agent ? effortsFor(preset.efforts, AGENT_MODELS[preset.agent.tool], draft.model) : (preset?.efforts ?? []);
  const effort = levels.length > 0 ? draft.effort.trim().toLowerCase() || null : null;
  return { id, display_name: draft.name.trim(), backend, persona: draft.persona.trim(), access: draft.access, effort, ...(draft.appearance ? { appearance: draft.appearance } : {}) };
}

/** A turn that is still running. */
interface TurnProgress {
  startedAt: number;
  /** What the bot has done so far, oldest first. */
  steps: string[];
  phase: "thinking" | "tool" | "writing";
}

const MAX_STEPS_SHOWN = 4;
/** How long Copy reads "Copied". */
const COPIED_MS = 1500;

function phaseLabel(phase: TurnProgress["phase"] | undefined): string {
  if (phase === "tool") return "Working";
  if (phase === "writing") return "Writing";
  return "Thinking";
}


const contextKey = (pane: string) => `apex-deck.context.${pane}`;

/** The context readings last saved for a pane, or none. */
function savedContext(pane: string): Record<string, ContextFill> {
  try {
    return JSON.parse(localStorage.getItem(contextKey(pane)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function saveContext(pane: string, fill: Record<string, ContextFill>) {
  if (Object.keys(fill).length) localStorage.setItem(contextKey(pane), JSON.stringify(fill));
  else localStorage.removeItem(contextKey(pane));
}

/** The provider whose plan an agent draws on, if it reports one. */
function planProvider(config: ParticipantConfig | undefined): AgentTool | null {
  const b = config?.backend;
  return b?.kind === "agent" && (b.tool === "claude_code" || b.tool === "codex") ? b.tool : null;
}

/** Tokens the latest request filled, against the window. */
interface ContextFill {
  used: number;
  window: number;
}

function describe(config: ParticipantConfig): string {
  const b = config.backend;
  const effort = config.effort ? ` · ${config.effort}` : "";
  if (b.kind === "open_ai_compatible") return `API · ${b.model}${effort}`;
  if (b.kind === "agent") return `${AGENT_LABEL[b.tool]} · ${b.model ?? "default model"}${effort}${config.access === "ask" ? " · asks first" : ""}`;
  if (b.kind === "cli") return `Command · ${b.program}`;
  return "Scripted";
}

/** The two scripted bots of the sample thread. */
const SAMPLE_BOTS: ParticipantConfig[] = [
  { id: "ada", display_name: "Ada", persona: "", access: "read", effort: null, appearance: { seed: "sample-ada", color: "#a78bfa" },
    backend: { kind: "scripted", lines: ["Hi, I'm Ada. Mention me with @ada, or everyone with @all.", "Ben sees everything I say, and I see what he says.", "[pass]"] } },
  { id: "ben", display_name: "Ben", persona: "", access: "read", effort: null, appearance: { seed: "sample-ben", color: "#60a5fa" },
    backend: { kind: "scripted", lines: ["I'm Ben. I answer when you @ben me. Try @all to hear from both of us.", "Add a real model with + Add bot when you're ready.", "[pass]"] } },
];

/** Starter roles offered in an empty Agents section. */
const STARTERS = [
  { name: "Reviewer", note: "Reads the change and flags bugs.", persona: "You are the reviewer. Read the change, look for bugs and risky edge cases, and be brief.", access: "read" as Access },
  { name: "Planner", note: "Breaks the work into steps.", persona: "You are the planner. Break the request into small, ordered steps and name the files each one touches.", access: "read" as Access },
  { name: "Implementer", note: "Makes the edits.", persona: "You are the implementer. Make the change in small steps and say what you changed.", access: "ask" as Access },
];

/** Below this width the artifacts panel covers the conversation instead of sitting beside it. */
const NARROW_PX = 760;

export function ChatPane({ pane, cwd, workspaceName = "", onStatus, onSeen, addRequest, agents, backend, focused, onActivity, onSignal, onApprovals, onServer, onPreview, onFork, menuRequest, profiles, onProfilesChange, disabledProviders, newThread = { policy: "mention", max_bot_hops: 3 }, newBotAccess = "read", confirmSteer = true, onConfirmSteer, profileMode = false, details }: Props) {
  // Read when a thread is first made, so changing settings never restarts an open one.
  const defaults = useRef({ newThread, newBotAccess });
  defaults.current = { newThread, newBotAccess };
  const [participants, setParticipants] = useState<ParticipantConfig[]>(profileMode ? profiles : []);
  const [options, setOptions] = useState<RoomOptions>(newThread);
  const [entries, setEntries] = useState<Entry[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [pins, setPins] = useState<string[]>([]);
  const [allowed, setAllowed] = useState<AllowedRule[]>([]);
  /** "Removed. Null asks again next time.", shown for a moment after Remove. */
  const [removedNote, setRemovedNote] = useState<string | null>(null);
  useEffect(() => {
    if (!removedNote) return;
    const timer = setTimeout(() => setRemovedNote(null), REMOVED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [removedNote]);
  const [unpinning, setUnpinning] = useState(false);
  const unpinPending = useRef(false);
  const removePin = (index: number) => {
    if (unpinPending.current) return;
    unpinPending.current = true; setUnpinning(true);
    backend.roomUnpin(pane.id, index).then(setPins)
      .catch((error) => notify(`Could not unpin: ${String(error)}`, "error"))
      .finally(() => { unpinPending.current = false; setUnpinning(false); });
  };
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Each running turn: when it began, the steps taken so far, and whether
   *  the bot is thinking, using a tool, or writing right now. */
  const [working, setWorking] = useState<Record<string, TurnProgress>>({});
  /** The clock, ticking once a second while any turn runs, for "12s". */
  const [now, setNow] = useState(() => Date.now());
  /** Tokens each participant has used in this thread, saved with it. */
  const [used, setUsed] = useState<Record<string, TokenTotals>>({});
  /** How full each agent's context window was on its latest request. Missing
   *  means unknown: not reported yet, or refilled by /compact since. */
  const [contextFill, setContextFill] = useState<Record<string, ContextFill>>({});
  /** Goes up on each /compact, to play the left side's refill. */
  const [compactions, setCompactions] = useState(0);
  const plans = usePlans();
  /** The chip whose usage card is open. */
  const [card, setCard] = useState<string | null>(null);
  /** What each bot has proposed and is waiting on a yes or no for, from the app-wide store (approvals.ts). */
  const approvalState = useSyncExternalStore(subscribeApprovals, approvalSnapshot);
  const roomCards = openCards(pane.id, approvalState);
  const asks = useMemo(() => cardsByBot(roomCards), [roomCards]);
  /** Files the bots have changed since this chat was opened. */
  const [changes, setChanges] = useState<MadeChange[]>([]);
  /** Files written this turn, by path, with who wrote them; see collectWritten. */
  const written = useRef(new Map<string, string>());
  const collectWritten = useRef<(bot: string) => void>(() => {});
  /** HTML or SVG fenced in a reply as it arrives; see collectReply below. */
  const collectReply = useRef<(message: { seq: number; text: string; speaker: Speaker }) => void>(() => {});
  const showChanges = Boolean(details?.open && details.target === pane.id && !details.collapsed.changes);
  const showChangesRef = useRef(false);
  showChangesRef.current = showChanges;
  const [diff, setDiff] = useState<ThreadDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const diffRequest = useRef(0);
  const loadDiff = () => {
    const request = ++diffRequest.current;
    setDiffLoading(true);
    backend.roomDiff(pane.id).then((next) => { if (request === diffRequest.current) setDiff(next); })
      .catch((error) => notify(`Could not read changes: ${String(error)}`, "error"))
      .finally(() => { if (request === diffRequest.current) setDiffLoading(false); });
  };
  const refreshDiff = useRef(loadDiff);
  refreshDiff.current = loadDiff;
  useEffect(() => { if (showChanges) refreshDiff.current(); }, [showChanges]);
  const [quickSettings, setQuickSettings] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [pendingSettings, setPendingSettings] = useState<Record<string, boolean>>({});
  const closeQuickSettings = () => setQuickSettings(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const composerMenu = useRef<ComposerMenuHandle>(null);
  const [queued, setQueued] = useState<ParticipantMessage[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [reply, setReply] = useState<ReplyQuote | null>(null);
  /** Whether the quote's Send to ▾ menu is open. */
  const [handOffOpen, setHandOffOpen] = useState(false);
  const handOffButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!reply) setHandOffOpen(false); }, [reply]);
  useEffect(() => {
    if (!handOffOpen) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".hand-off")) setHandOffOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setHandOffOpen(false);
      handOffButton.current?.focus();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key, true); };
  }, [handOffOpen]);
  const [adding, setAdding] = useState(false);
  /** Where the quick add menu is open: under the empty thread's button, or in the sidebar. */
  const [quickAdd, setQuickAdd] = useState<"empty" | "details" | "roster" | null>(null);
  // The chip row scrolls sideways, which clips anything absolutely positioned inside it, so the roster menu is placed against the viewport.
  const [rosterAnchor, setRosterAnchor] = useState<{ left: number; top: number } | null>(null);
  /** True once the person types a name, so choosing a model stops renaming the bot. */
  const nameTouched = useRef(false);
  useEffect(() => {
    if (!quickAdd) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".quick-add-wrap")) setQuickAdd(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setQuickAdd(null); } };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key, true); };
  }, [quickAdd]);
  /** The bot whose ⋯ menu is open in the details sidebar. */
  const [botMenu, setBotMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!botMenu) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".pane-menu-wrap")) setBotMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setBotMenu(null); };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key); };
  }, [botMenu]);
  const installed = (preset: Preset) => !preset.agent || agents.some((a) => a.key === preset.agent!.detectKey && a.found);
  // Start on the first agent that is installed, or on local models.
  const availablePresets = PRESETS.filter((p) => providerEnabled(p.key, disabledProviders));
  const firstPreset = (availablePresets.find((p) => p.agent && installed(p)) ?? availablePresets[0] ?? PRESETS[0]).key;
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(firstPreset, newBotAccess));
  const [apiModels, setApiModels] = useState<string[]>([]);
  const [modelNote, setModelNote] = useState("");
  /** What each coding agent reports it can use, asked once per tool. */
  const [reported, setReported] = useState<Partial<Record<AgentTool, ModelChoice[]>>>({});
  const [formError, setFormError] = useState("");
  /** The id of the participant being edited, or null when adding a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  const [ready, setReady] = useState(profileMode);

  useEffect(() => { if (profileMode) setParticipants(profiles); }, [profiles, profileMode]);
  /** The window has focus; a thread counts as watched only then. */
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setWindowFocused(true);
    const off = () => setWindowFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => { window.removeEventListener("focus", on); window.removeEventListener("blur", off); };
  }, []);
  const watching = focused && windowFocused && ready && !profileMode;
  const watchingRef = useRef(watching);
  watchingRef.current = watching;

  const noticeKey = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  // Grow the message box with its text, up to the CSS max-height.
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }, [text]);
  /** Whether the transcript sat at its bottom when it was last scrolled. New
   *  content follows only then; scrolled up, the transcript keeps your place. */
  const stuck = useRef(true);
  /** Bot replies that arrived while you were scrolled up. */
  const [unread, setUnread] = useState(0);
  /** The chat's root element; its pane's size decides what fits. */
  const root = useRef<HTMLDivElement>(null);
  /** False in a pane under 260px tall, where the recipient line is hidden. */
  const [lineFits, setLineFits] = useState(true);
  useEffect(() => {
    const paneBox = root.current?.closest<HTMLElement>(".pane");
    if (!paneBox) return;
    const observer = new ResizeObserver(() => {
      // A hidden pane measures nothing; keep what it had.
      if (paneBox.offsetWidth === 0 && paneBox.offsetHeight === 0) return;
      setLineFits(showsRecipientLine(paneBox.offsetHeight));
    });
    observer.observe(paneBox);
    return () => observer.disconnect();
  }, []);
  /** Open approval cards wholly out of view, oldest first. */
  const [cardsAway, setCardsAway] = useState<CardBox[]>([]);
  /** Find the open cards on screen and note which are out of view. */
  const measureCards = () => {
    const el = scroller.current;
    if (!el || el.clientHeight === 0) return;
    const view = el.getBoundingClientRect();
    const boxes = [...el.querySelectorAll<HTMLElement>(".approval[data-request]:not([data-answered])")].map((card) => {
      const box = card.getBoundingClientRect();
      return { by: card.dataset.by ?? "", request: card.dataset.request ?? "", top: box.top, bottom: box.bottom };
    });
    const away = cardsOutOfView(boxes, view.top, view.bottom);
    setCardsAway((old) => (old.map((c) => c.request).join("\n") === away.map((c) => c.request).join("\n") ? old : away));
  };
  /** Bring a card to the middle of the view and put focus on its Allow once. */
  const showCard = (request: string) => {
    const el = scroller.current;
    const card = el?.querySelector<HTMLElement>(`.approval[data-request="${CSS.escape(request)}"]`);
    if (!el || !card) return;
    const box = card.getBoundingClientRect();
    const view = el.getBoundingClientRect();
    el.scrollTop += box.top - view.top - Math.max(12, (el.clientHeight - box.height) / 2);
    card.querySelector<HTMLButtonElement>('button[data-answer="once"]')?.focus({ preventScroll: true });
  };
  /** "New since you looked" sits above the message with this seq. */
  const [dividerAt, setDividerAt] = useState<number | null>(null);
  /** Set when the thread opens with replies you missed, until the view has moved to the divider. */
  const opening = useRef(false);
  /** The newest message seen at the bottom, as last saved. */
  const lastSeenRef = useRef(pane.lastSeenSeq);
  const filePicker = useRef<HTMLInputElement>(null);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [tldr, setTldr] = useState(() => loadTldr(pane.id));
  const toggleTldr = () => setTldr((on) => { saveTldr(pane.id, !on); return !on; });
  const field = useRef<HTMLDivElement>(null);
  const saving = attached.some((a) => !a.path && !a.error);
  const sendable = attached.filter((a) => a.path);
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const signal = useRef(onSignal);
  signal.current = onSignal;
  const approvals = useRef(onApprovals);
  approvals.current = onApprovals;
  const preview = useRef(profileMode ? undefined : onPreview);
  preview.current = profileMode ? undefined : onPreview;
  // What happened in the round of replies now running, to decide when it
  // ends whether the chat wants attention. See afterRound in attention.ts.
  const round = useRef<{ failed: string[]; lastReply: string | null; stopped: boolean }>({ failed: [], lastReply: null, stopped: false });
  /** When each bot was last heard from in its turn, for the quiet warning. See heardFrom. */
  const heard = useRef(new Map<string, number>());
  /** Agents whose context is at or under the low mark, so the notice shows
   *  once per crossing; and notices waiting for the agent's reply to land. */
  const lowContext = useRef(new Set<string>());
  const pendingLow = useRef(new Map<string, number>());

  const availableProfiles = profiles.filter((p) => providerEnabled(providerForConfig(p), disabledProviders));

  const names = useMemo(() => new Map(participants.map((p) => [p.id, p.display_name])), [participants]);
  const namesRef = useRef(names);
  namesRef.current = names;
  const identities = useRef(new Map<string, AgentAppearance>());
  for (const p of [...participants, ...profiles]) {
    identities.current.set(p.id, p.appearance ?? legacyAppearance(p.id));
  }
  const appearance = (id: string) => identities.current.get(id) ?? legacyAppearance(id);
  const color = (id: string) => appearance(id).color;
  // Who is at work right now, for the line above the composer: bots still
  // replying, and bots stopped on an approval card waiting for you.
  /** You have written in this thread, so the room may have someone you addressed last. */
  const addressedBefore = messagesOf(entries).some((m) => m.speaker.kind === "human");
  const copy = composerCopy(busy, participants.length === 0, { firstMessage: participants.length >= 2 && !addressedBefore, quoting: Boolean(reply) });
  /** Who a quote will lead with right now, for its Send to ▾ button. */
  const quoteTo = reply ? quoteLead(text.trim(), reply, participants.map((p) => p.id)) : null;

  // Keep the last context reading so the meters show it straight after a restart.
  const contextLoaded = useRef(false);
  useEffect(() => {
    if (contextLoaded.current) saveContext(pane.id, contextFill);
  }, [pane.id, contextFill]);

  const forgetContext = () => {
    setContextFill({});
    lowContext.current.clear();
    pendingLow.current.clear();
  };

  const notify = (message: string, tone: Notice["tone"] = "info", action?: NoticeAction) =>
    setEntries((list) => [...list, { kind: "notice", notice: { key: noticeKey.current++, text: message, tone, ...(action ? { action } : {}) } }]);

  useEffect(() => {
    if (profileMode) return;
    let alive = true;
    const nameOf = (id: string) => namesRef.current.get(id) ?? id;
    /** Tell the app what this thread's open cards want. The store has seen the event already (hub.ts). */
    const reportApprovals = () => approvals.current?.(pane.id, approvalSignal(openCards(pane.id), namesRef.current, Date.now()));
    const unregister = registerRoom(pane.id, (event: RoomEvent) => {
      activity.current(pane.id);
      const heardId = heardFrom(event);
      if (heardId) heard.current.set(heardId, Date.now());
      if (event.type === "tool_servers") { setServerErrors(errors => { const next = {...errors}; delete next[event.id]; return next; }); setServerLists(lists => ({...lists, [event.id]: event.servers})); return; }
      switch (event.type) {
        case "message_added":
          if (event.message.speaker.kind === "bot") {
            const id = event.message.speaker.id;
            if (!stuck.current) setUnread((n) => n + 1);
            setDrafts(({ [id]: _done, ...rest }) => rest);
            setWorking(({ [id]: _done, ...rest }) => rest);
            round.current.lastReply = event.message.text;
            // A server a bot names as it replies opens beside the thread.
            // Replies loaded with the thread don't: those were seen already.
            const servers = findServerUrls(event.message.text);
            if (servers.length > 0) preview.current?.(servers[servers.length - 1], true);
            collectReply.current(event.message);
            const left = pendingLow.current.get(id);
            pendingLow.current.delete(id);
            if (left !== undefined) {
              const low: Entry = { kind: "low", low: { key: noticeKey.current++, id, left } };
              setEntries((list) => [...list, { kind: "message", message: event.message }, low]);
              break;
            }
          } else {
            // The person has just written: a new round, and nothing is waiting on them.
            round.current = { failed: [], lastReply: null, stopped: false };
            signal.current?.(pane.id, null);
          }
          setEntries((list) => [...list, { kind: "message", message: event.message }]);
          break;
        case "editor_changed":
          setEditor(event.id);
          break;
        case "participant_idle":
          setPendingSettings(({ [event.id]: _applied, ...rest }) => rest);
          setDrafts(({ [event.id]: _done, ...rest }) => rest);
          setWorking(({ [event.id]: _done, ...rest }) => rest);
          reportApprovals();
          turnQueue.idle(event.id);
          heard.current.delete(event.id);
          collectWritten.current(event.id);
          break;
        case "turn_started":
          turnQueue.started(event.id);
          setDrafts((d) => ({ ...d, [event.id]: "" }));
          setNow(Date.now());
          setWorking((w) => ({ ...w, [event.id]: { startedAt: Date.now(), steps: [], phase: "thinking" } }));
          break;
        case "delta":
          setDrafts((d) => ({ ...d, [event.id]: (d[event.id] ?? "") + event.text }));
          setWorking((w) => (w[event.id] && w[event.id].phase !== "writing" ? { ...w, [event.id]: { ...w[event.id], phase: "writing" } } : w));
          break;
        case "activity":
          setWorking((w) => {
            const turn = w[event.id] ?? { startedAt: Date.now(), steps: [], phase: "thinking" as const };
            return { ...w, [event.id]: { ...turn, steps: [...turn.steps, event.text], phase: "tool" } };
          });
          break;
        case "approval_requested":
        case "approval_resolved":
          // The turn is stuck until the person answers, wherever they are
          // looking, so the flag is blocking until the last card is answered.
          reportApprovals();
          break;
        case "changed":
          setChanges((list) => [...list, { seq: list.length, by: event.id, change: event.change }]);
          written.current.set(event.change.path, event.id);
          break;
        case "allowed_changed":
          setAllowed(event.allowed);
          break;
        case "usage":
          setUsed((u) => {
            const before = u[event.id] ?? { input: 0, output: 0, turns: 0 };
            return { ...u, [event.id]: { input: before.input + (event.input_tokens ?? 0), output: before.output + (event.output_tokens ?? 0), turns: before.turns + 1 } };
          });
          break;
        case "context_usage": {
          const fill = { used: event.used_tokens, window: event.window_tokens };
          const level = contextLevel(fill);
          const low = isLow(level);
          // The notice goes under the reply this figure belongs to, which
          // lands just after it.
          if (low && !lowContext.current.has(event.id)) pendingLow.current.set(event.id, percent(level ?? 0));
          if (low) lowContext.current.add(event.id);
          else {
            lowContext.current.delete(event.id);
            pendingLow.current.delete(event.id);
          }
          setContextFill((all) => ({ ...all, [event.id]: fill }));
          break;
        }
        case "passed":
          setDrafts(({ [event.id]: _gone, ...rest }) => rest);
          setWorking(({ [event.id]: _gone, ...rest }) => rest);
          notify(`${nameOf(event.id)} had nothing to add.`);
          break;
        case "failed":
          turnQueue.error(event.id);
          setDrafts(({ [event.id]: _gone, ...rest }) => rest);
          setWorking(({ [event.id]: _gone, ...rest }) => rest);
          round.current.failed.push(nameOf(event.id));
          notify(`${nameOf(event.id)} could not reply: ${event.error}`, "error", retryFor(event.id, [...namesRef.current.keys()]) ?? undefined);
          break;
        case "hop_limit_reached": {
          const roster = [...namesRef.current.keys()];
          const action: NoticeAction | undefined = event.next.length > 0 ? { kind: "let", ids: event.next } : undefined;
          // Read the asker from the newest list: its reply may have landed in this same tick.
          setEntries((list) => {
            const asker = askerOf(messagesOf(list), event.next, roster);
            const text = hopNotice(event.limit, asker && nameOf(asker), event.next.map(nameOf));
            return [...list, { kind: "notice", notice: { key: noticeKey.current++, text, tone: "info", ...(action ? { action } : {}) } }];
          });
          break;
        }
        case "compacted":
          setDrafts(({ [event.id]: _done, ...rest }) => rest);
          setWorking(({ [event.id]: _done, ...rest }) => rest);
          setEntries((list) => [...list, { kind: "summary", summary: { by: event.id, summary: event.summary, upto: event.upto } }]);
          // Every model now sees the summary instead, so how full each window
          // is stays unknown until its next turn says.
          forgetContext();
          setCompactions((n) => n + 1);
          break;
        case "stopped":
          setDrafts({});
          setWorking({});
          round.current.stopped = true;
          notify("Stopped.");
          break;
        case "idle": {
          setPendingSettings({});
          reportApprovals();
          if (turnQueue.active) break;
          if (showChangesRef.current) refreshDiff.current();
          // A round the person stopped themselves needs no flag.
          const wants = round.current.stopped ? null : afterRound(round.current.failed, round.current.lastReply);
          if (wants) signal.current?.(pane.id, wants.kind, wants.note);
          round.current = { failed: [], lastReply: null, stopped: false };
          setBusy(turnQueue.active);
          setDrafts({});
          setWorking({});
          break;
        }
      }
    });
    backend
      .roomCreate(pane.id, pane.sample ? SAMPLE_BOTS : [], defaults.current.newThread, cwd)
      .then((saved) => {
        if (!alive) return;
        setChanges((saved.changes ?? []).map((c) => ({ seq: c.seq, by: c.by, change: { path: c.path, added: c.added, removed: c.removed, diff: "" } })));
        setParticipants(saved.participants);
        setOptions(saved.options);
        setPins(saved.pins ?? []);
        setAllowed(saved.allowed ?? []);
        setUsed(saved.usage ?? {});
        setContextFill(savedContext(pane.id));
        contextLoaded.current = true;
        const restored: Entry[] = saved.transcript.map((message) => ({ kind: "message", message }));
        // A saved summary does not say who wrote it.
        if (saved.compaction) restored.splice(Math.min(saved.compaction.upto, restored.length), 0, { kind: "summary", summary: { by: null, ...saved.compaction } });
        setEntries(restored);
        // Open at "New since you looked" when replies came in after you last looked.
        const seen = seenList(saved.transcript);
        const from = firstUnseen(seen, lastSeenRef.current);
        setDividerAt(from);
        if (from !== null) {
          opening.current = true;
          setUnread(unseenCount(seen, from));
        }
        setReady(true);
      })
      .catch((error) => notify(`Could not create the chat: ${String(error)}`, "error"));
    return () => {
      alive = false;
      unregister();
      forgetRoom(pane.id);
      approvals.current?.(pane.id, null);
      backend.roomClose(pane.id).catch(() => {});
    };
    // The room lives as long as the pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, profileMode]);

  // Keep the elapsed times moving while anything is running.
  const running = Object.keys(working).length > 0;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  /** Open a file, folder or web address a message links to. A local server opens in a Preview. */
  const openTarget = (target: string, reveal = false) => {
    const address = /^https?:\/\//i.test(target) ? normalizeAddress(target) : null;
    if (address && isLocalHost(new URL(address).hostname) && preview.current) return preview.current(address, false);
    backend.openTarget(target, cwd || null, reveal).catch((error) => notify(`Could not open ${target}: ${String(error)}`, "error"));
  };

  // Paths named in code spans, asked about once per folder; a file written
  // later is picked up when the thread is opened again.
  const pathChecks = useMemo(() => new Map<string, Promise<boolean>>(), [cwd]);
  const pathExists = useCallback((path: string) => {
    let known = pathChecks.get(path);
    if (!known) {
      known = backend.pathsExist([path], cwd || null).then(([yes]) => Boolean(yes), () => false);
      pathChecks.set(path, known);
    }
    return known;
  }, [pathChecks, cwd]);

  // A model's picture may live outside the attachments folder (Codex keeps
  // its own); a copy is taken the first time it is shown.
  const readReplyImage = useCallback(
    (path: string) => backend.importReplyImage(pane.id, path).then(backend.readAttachment),
    [pane.id],
  );

  /** Bring the transcript to where it should be after anything changed in it. */
  const settle = useRef(() => {});
  settle.current = () => {
    const el = scroller.current;
    // A hidden pane cannot scroll; the resize when it is shown settles it.
    if (!el || el.clientHeight === 0) return;
    const mark = opening.current ? el.querySelector<HTMLElement>(".unseen-divider") : null;
    if (mark) {
      // A thread with replies you missed opens at its divider, just below the top.
      opening.current = false;
      el.scrollTop += mark.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
      stuck.current = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
      if (stuck.current) setUnread(0);
    } else if (stuck.current) el.scrollTop = el.scrollHeight;
    measureCards();
  };
  // Before paint, so following the bottom never flickers.
  useLayoutEffect(() => settle.current(), [entries, drafts, asks, dividerAt]);
  // Showing the pane, or a composer that grows, changes the transcript's
  // height without any scrolling: stay at the bottom if you were there.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => settle.current());
    observer.observe(el);
    return () => observer.disconnect();
  }, [profileMode]);
  /** While you watch the bottom of the thread, everything in it counts as seen. */
  const markSeen = useRef(() => {});
  markSeen.current = () => {
    if (!watchingRef.current || !stuck.current) return;
    const next = seenMark(seenList(messagesOf(entriesRef.current)), lastSeenRef.current);
    if (next === null) return;
    lastSeenRef.current = next;
    onSeen?.(pane.id, next);
  };
  // Coming back to the thread marks where the replies you missed begin.
  const wasWatching = useRef(false);
  useEffect(() => {
    if (watching && !wasWatching.current) {
      const from = firstUnseen(seenList(messagesOf(entriesRef.current)), lastSeenRef.current);
      if (from !== null) setDividerAt(from);
    }
    wasWatching.current = watching;
  }, [watching]);
  useEffect(() => markSeen.current(), [entries, watching]);
  const onTranscriptScroll = () => {
    const el = scroller.current;
    if (!el || el.clientHeight === 0) return;
    stuck.current = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (stuck.current) { setUnread(0); markSeen.current(); }
    measureCards();
  };
  const jumpToLatest = () => {
    stuck.current = true;
    setUnread(0);
    settle.current();
  };

  useEffect(() => {
    if (focused && !adding && ready) input.current?.focus();
  }, [focused, adding, ready]);

  const closeForm = (preset: PresetKey) => {
    setDraft(emptyDraft(preset, defaults.current.newBotAccess));
    setFormError("");
    setAdding(false);
    setEditing(null);
  };

  const saveParticipant = async () => {
    if (!editing && !providerEnabled(draft.preset, disabledProviders)) return setFormError("This provider is disabled. Enable it in Providers to add a bot.");
    const built = draftToConfig(draft);
    if (typeof built === "string") return setFormError(built);
    // When editing, the @handle stays the same even if the name changes.
    const config = { ...built, id: editing ?? built.id, appearance: built.appearance ?? (editing ? appearance(editing) : createAppearance([...identities.current.values()])) };
    if (!editing && participants.some((p) => p.id === config.id)) {
      return setFormError(`@${config.id} is already in this chat. Pick a different name.`);
    }
    try {
      if (profileMode) {
        const next = editing ? participants.map((p) => p.id === editing ? config : p) : [...participants, config];
        setParticipants(next);
        onProfilesChange(next);
      } else if (editing) {
        await backend.roomUpdateParticipant(pane.id, config);
        setParticipants((list) => list.map((p) => (p.id === editing ? config : p)));
        if (profiles.some(p => p.id === editing)) onProfilesChange(profiles.map(p => p.id === editing ? { ...p, appearance: config.appearance } : p));
      } else {
        await backend.roomAddParticipant(pane.id, config);
        setParticipants((list) => [...list, config]);
      }
      if (config.backend.kind === "agent" && config.backend.model) rememberModel(draft.preset, config.backend.model);
      closeForm(draft.preset);
      return true;
    } catch (error) {
      setFormError(String(error));
    }
  };

  const startEditing = (config: ParticipantConfig) => {
    setDraft(configToDraft({ ...config, appearance: appearance(config.id) }));
    setFormError("");
    setApiModels([]);
    setModelNote("");
    setEditing(config.id);
    setAdding(true);
  };

  const removeParticipant = async (id: string) => {
    try {
      if (!profileMode) await backend.roomRemoveParticipant(pane.id, id);
      const next = participants.filter((p) => p.id !== id);
      setParticipants(next);
      if (profileMode) onProfilesChange(next);
    } catch (error) { notify(`Could not remove the bot: ${String(error)}`, "error"); return; }
    if (editing === id) closeForm(draft.preset);
  };

  const changeOptions = (next: RoomOptions) => {
    setOptions(next);
    backend.roomSetOptions(pane.id, next).catch((error) => notify(`Could not save chat settings: ${String(error)}`, "error"));
  };

  /** Empty the chat so the models start fresh. The participants stay. */
  const clearChat = () => {
    setText("");
    setReply(null);
    backend
      .roomClear(pane.id)
      .then(() => {
        setEntries([]);
        setPins(pinsAfterClear);
        setDividerAt(null);
        // Messages count from 0 again; nothing in the cleared thread is new.
        lastSeenRef.current = -1;
        onSeen?.(pane.id, -1);
        forgetContext();
        notify("Chat cleared. The models start fresh; participants are kept.");
      })
      .catch((error) => notify(`Could not clear the chat: ${String(error)}`, "error"));
  };

  /** Have a model summarize the chat. The models then see the summary in
   *  place of the messages so far; the person still sees them all. */
  const compactChat = () => {
    setText("");
    setReply(null);
    setBusy(true);
    void turnQueue.send("/compact", "compact").catch(error => notify(String(error), "error"));
  };

  const dispatch = useRef<(message: string, to: string[], kind: TurnKind, hops?: number | null) => Promise<void>>(async () => {});
  dispatch.current = async (message, to, kind, hops) => {
    if (kind === "compact") {
      try { await backend.roomCompact(pane.id); }
      finally { to.forEach(id => turnQueue.idle(id)); }
    } else if (kind === "turn") await backend.roomTurn(pane.id, to, hops ?? null);
    else await backend.roomPostTo(pane.id, message, to);
  };
  const [turnQueue] = useState(() => new ParticipantQueues(
    message => backend.roomTargets(pane.id, message),
    (message, to, kind, hops) => dispatch.current(message, to, kind, hops),
    id => backend.roomStop(pane.id, id),
    // A one-off turn has no text to show or edit, so the queue line leaves it out.
    items => { setQueued(items.filter(item => item.kind !== "turn")); setBusy(turnQueue.active); setQueuePaused(turnQueue.paused.size > 0); },
    error => { notify(`Could not send: ${String(error)}. Affected queues are paused.`, "error"); },
  ));
  /** This thread's own steer choice, over Settings. */
  const [steerChoice, setSteerChoice] = useState<ThreadSteer>(() => threadSteer(pane.id));
  const chooseSteer = (choice: ThreadSteer) => { setSteerChoice(choice); saveThreadSteer(pane.id, choice); };
  /** The queued message whose Steer is asking first. */
  const [steerAsking, setSteerAsking] = useState<number | null>(null);
  /** Steer a queued message: stop its bots mid-turn and give it to them now. */
  const steerQueued = (item: ParticipantMessage) => void turnQueue.steerQueued(item.id);
  /** Steer, asking first unless this thread or Settings says not to. */
  const askToSteer = (item: ParticipantMessage) => {
    if (steerAsks(confirmSteer, steerChoice)) setSteerAsking(item.id);
    else steerQueued(item);
  };
  const answerSteer = (item: ParticipantMessage, answer: SteerAnswer) => {
    const result = steerAnswer(answer);
    setSteerAsking(null);
    if (result.thread) chooseSteer(result.thread);
    if (result.confirmSteer !== undefined) onConfirmSteer?.(result.confirmSteer);
    if (result.steer) steerQueued(item);
  };
  useEffect(() => { if (steerAsking !== null && !queued.some((item) => item.id === steerAsking)) setSteerAsking(null); }, [queued, steerAsking]);
  /** The queued message being edited in the transcript. */
  const [editingQueued, setEditingQueued] = useState<number | null>(null);
  /** When the round button last flipped between Send and Stop; clicks right after are ignored. */
  const flippedAt = useRef(0);
  useEffect(() => { flippedAt.current = Date.now(); }, [busy]);
  /** Notices whose button you pressed; each works once. */
  const usedActions = useRef(new Set<number>());
  const [usedKeys, setUsedKeys] = useState<ReadonlySet<number>>(() => new Set());
  const liveKeys = liveActions(entries.map((entry) => ({
    key: entry.kind === "notice" && entry.notice.action ? entry.notice.key : null,
    human: entry.kind === "message" && entry.message.speaker.kind === "human",
  })), usedKeys);
  /** Try again or Let them answer: run those bots once on the transcript as it is. */
  const noticeButton = (key: number, action: NoticeAction) => {
    const ids = stillHere(action, participants.map((p) => p.id));
    if (ids.length === 0 || !liveKeys.has(key)) return null;
    const label = action.kind === "retry" ? "Try again" : letLabel(ids.map((id) => names.get(id) ?? id));
    return <button type="button" className="ghost small" disabled={ids.some((id) => working[id])} onClick={() => {
      if (usedActions.current.has(key)) return;
      usedActions.current.add(key);
      setUsedKeys(new Set(usedActions.current));
      // Let them answer buys exactly one reply each; Try again keeps the room's round limit.
      turnQueue.turn(ids, action.kind === "let" ? 0 : null);
    }}>{label}</button>;
  };
  const forkAt = (title: string, upto: number | null) => {
    if (!onFork) return notify("Forking is available in workspace threads.", "error");
    return onFork(title, upto)
      .then((name) => notify(`Forked into “${name}”. Both threads work in the same folder, so file edits in one show up in the other.`))
      .catch((error) => notify(`Could not fork: ${String(error)}`, "error"));
  };
  const forkIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v5a3 3 0 0 0 3 3 3 3 0 0 1 3 3v1M11 2v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="5" cy="2.5" r="1.2"/><circle cx="11" cy="2.5" r="1.2"/></svg>;
  /** The message whose Copy reads "Copied" for a moment, by seq. */
  const [copied, setCopied] = useState<number | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  /** Put a message's markdown on the clipboard. */
  const copyMessage = (message: Message) => {
    if (!navigator.clipboard) return notify("Could not copy: the clipboard isn't available here.", "error");
    navigator.clipboard.writeText(message.text)
      .then(() => {
        setCopied(message.seq);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
      })
      .catch((error) => notify(`Could not copy: ${String(error)}`, "error"));
  };
  /** The message whose action controls are expanded, by seq. */
  const [messageMenu, setMessageMenu] = useState<number | null>(null);
  useEffect(() => {
    if (messageMenu === null) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".message-actions")) setMessageMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      scroller.current?.querySelector<HTMLButtonElement>(`[data-message-more="${messageMenu}"]`)?.focus();
      setMessageMenu(null);
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key, true); };
  }, [messageMenu]);
  /** Text picked inside one message, with where to float Add to chat / More details. */
  const [picked, setPicked] = useState<{ message: Message; text: string; x: number; y: number } | null>(null);
  const pickSelection = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!selection || !text || selection.rangeCount === 0) return setPicked(null);
    const range = selection.getRangeAt(0);
    const start = (range.startContainer as Element).parentElement?.closest?.("[data-seq]") ?? (range.startContainer as Element).closest?.("[data-seq]");
    const end = (range.endContainer as Element).parentElement?.closest?.("[data-seq]") ?? (range.endContainer as Element).closest?.("[data-seq]");
    if (!start || start !== end) return setPicked(null);
    const message = messagesOf(entries).find((m) => m.seq === Number(start.getAttribute("data-seq")));
    if (!message) return setPicked(null);
    const box = range.getBoundingClientRect();
    setPicked({ message, text, x: box.left + box.width / 2, y: box.top });
  };
  const pickedQuote = (p: NonNullable<typeof picked>): ReplyQuote => ({ ...quoteFor(p.message, (id) => names.get(id) ?? id), text: p.text });
  const addPicked = () => {
    if (!picked) return;
    setReply(pickedQuote(picked)); setPicked(null);
    window.getSelection()?.removeAllRanges();
    input.current?.focus();
  };
  const explainPicked = () => {
    if (!picked || !ready || participants.length === 0) return;
    const message = replyText("Explain this part in more detail.", pickedQuote(picked), participants.map((p) => p.id));
    setPicked(null);
    window.getSelection()?.removeAllRanges();
    stuck.current = true;
    void turnQueue.send(message).catch((error) => notify(String(error), "error"));
  };
  const retryIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  const revertIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4v3.5h3.5M3.4 7.3A5 5 0 1 1 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  /** The Retry or Revert waiting on its confirmation. */
  const [goingBack, setGoingBack] = useState<{ kind: GoBack; message: Message; plan: RevertPlan; scope: RevertScope; ticked: string[] } | null>(null);
  /** Retry on a bot's reply, Revert on your message: delete from there, put this thread's files back. */
  const goBack = (message: Message) => {
    if (busy) return notify("Stop the bots first.", "error");
    const kind: GoBack = message.speaker.kind === "bot" ? "retry" : "revert";
    const bot = message.speaker.kind === "bot" ? message.speaker.id : null;
    if (kind === "retry" && !participants.some((p) => p.id === bot)) return notify(`${names.get(bot ?? "") ?? bot} isn't in this thread any more, so it can't answer again.`, "error");
    void backend.roomRevertPlan(pane.id, message.seq, bot).then((plan) => {
      if (goBackAsks(goBackAlways(kind), plan)) setGoingBack({ kind, message, plan, scope: "both", ticked: initialFiles(plan) });
      else runGoBack(kind, message, plan, "both", initialFiles(plan));
    }).catch((error) => notify(`Could not ${kind}: ${String(error)}`, "error"));
  };
  const runGoBack = (kind: GoBack, message: Message, plan: RevertPlan, scope: RevertScope, ticked: string[]) => {
    setGoingBack(null);
    const bot = message.speaker.kind === "bot" ? message.speaker.id : null;
    const request = goBackRequest(kind === "retry" ? "both" : scope, plan, ticked);
    void backend.roomRevert(pane.id, message.seq, bot, request.chat, request.files).then((failed) => {
      if (request.chat) setPins(list => list.filter(pin => { const seq = pinSource(pin); return seq === null || seq < message.seq; }));
      if (request.chat) setEntries((list) => {
        const first = list.findIndex((e) => e.kind === "message" && e.message.seq >= message.seq);
        return first < 0 ? list : list.slice(0, first);
      });
      const problem = failedLine(failed);
      if (problem) notify(problem, "error");
      else if (request.files.length) notify(`Put back ${request.files.length === 1 ? request.files[0] : `${request.files.length} files`}.`, "info");
      if (kind === "revert" && request.chat) { setText(message.text); input.current?.focus(); }
      if (kind === "retry" && bot) { stuck.current = true; turnQueue.turn([bot], null); }
    }).catch((error) => notify(`Could not ${kind}: ${String(error)}`, "error"));
  };
  const answerGoBack = (always: boolean) => {
    if (!goingBack) return;
    if (always) saveGoBackAlways(goingBack.kind, true);
    runGoBack(goingBack.kind, goingBack.message, goingBack.plan, goingBack.scope, goingBack.ticked);
  };
  /** The Retry/Revert confirmation under a message's actions. */
  const goBackPop = (message: Message) => {
    if (!goingBack || goingBack.message.seq !== message.seq) return null;
    const { kind, plan, scope, ticked } = goingBack;
    const who = names.get(message.speaker.kind === "bot" ? message.speaker.id : "") ?? "the bot";
    const showFiles = plan.available && plan.files.length > 0 && !(kind === "revert" && scope === "chat");
    const toggle = (path: string) => setGoingBack((g) => g && { ...g, ticked: g.ticked.includes(path) ? g.ticked.filter((p) => p !== path) : [...g.ticked, path] });
    return <div className="steer-pop goback-pop" role="dialog" aria-label={kind === "retry" ? "Retry?" : "Revert?"}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setGoingBack(null); } }}>
      <strong>{goBackTitle(kind, plan, who)}</strong>
      {plan.note && <p>{plan.note}</p>}
      {kind === "revert" && plan.available && plan.files.length > 0 && <div className="goback-scope" role="radiogroup" aria-label="What goes back">
        {([["both", "Files and chat"], ["chat", "Chat only"], ["files", "Files only"]] as const).map(([value, label]) =>
          <label key={value}><input type="radio" name={`goback-${pane.id}`} checked={scope === value} onChange={() => setGoingBack((g) => g && { ...g, scope: value })} />{label}</label>)}
      </div>}
      {showFiles && <ul className="goback-files">
        {plan.files.map((file) => <li key={file.path}>
          <label title={file.conflict ? "Also changed outside this thread's turns. Untick to keep it as it is now." : undefined}>
            <input type="checkbox" checked={ticked.includes(file.path)} onChange={() => toggle(file.path)} />
            <code>{file.path}</code>
            {file.delete && <em>deleted</em>}
            {file.conflict && <em className="warn">also changed elsewhere</em>}
          </label>
        </li>)}
      </ul>}
      {showFiles && plan.skipped.length > 0 && <p>Too big to save, so left as they are: {plan.skipped.join(", ")}</p>}
      {plan.effects.length > 0 && <p className="goback-effects">Can't be undone: {plan.effects.map((effect, i) => <span key={i}><code>{effect.command}</code> ({names.get(effect.by) ?? effect.by}){i < plan.effects.length - 1 ? ", " : ""}</span>)}</p>}
      {kind === "revert" && scope !== "files" && <p>Your message goes back in the box, unsent.</p>}
      <div className="row">
        <button type="button" className="primary small" autoFocus onClick={() => answerGoBack(false)}>Allow once</button>
        <button type="button" className="ghost small" onClick={() => answerGoBack(true)}>Allow always</button>
        <button type="button" className="link" onClick={() => setGoingBack(null)}>Cancel</button>
      </div>
    </div>;
  };
  /** Directional disclosure for message actions; a menu in narrow panes. */
  const messageActions = (message: Message) => {
    const quote = () => { setReply(quoteFor(message, (id) => names.get(id) ?? id)); input.current?.focus(); };
    const copy = () => copyMessage(message);
    const fork = () => forkAt(`${pane.title} (fork)`, message.seq + 1);
    const goBackKind: GoBack | null = message.speaker.kind === "bot" ? "retry" : message.speaker.kind === "human" ? "revert" : null;
    const goBackLabel = goBackKind === "retry" ? "Retry" : "Revert to here";
    const goBackHint = busy ? "Stop the bots first" : goBackKind === "retry" ? "Retry: delete this reply and after, put files back, ask again" : "Revert: delete everything after, put files back, your text returns to the box";
    const copiedHere = copied === message.seq;
    const pinIndex = pins.findIndex(pin => pinSource(pin) === message.seq);
    const pinned = pinIndex >= 0;
    const canPin = message.speaker.kind === "bot" || message.speaker.kind === "human";
    const pinTarget = message.speaker.kind === "human" ? "your message" : "response";
    const pinLabel = `${pinned ? "Unpin" : "Pin"} ${pinTarget}`;
    const togglePin = () => {
      if (unpinPending.current) return;
      if (pinned) return removePin(pinIndex);
      unpinPending.current = true; setUnpinning(true);
      void backend.roomPin(pane.id, responsePin(message.seq, message.text)).then(setPins)
        .catch(error => notify(`Could not pin: ${String(error)}`, "error"))
        .finally(() => { unpinPending.current = false; setUnpinning(false); });
    };
    const expanded = messageMenu === message.seq;
    const disclosure = <button type="button" className="msg-action action-disclosure" data-message-more={message.seq}
      title={expanded ? "Hide message actions" : "Show message actions"}
      aria-label={expanded ? "Hide message actions" : "Show message actions"} aria-expanded={expanded}
      onClick={() => setMessageMenu(open => open === message.seq ? null : message.seq)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={actionChevron(message.speaker.kind, expanded) === "‹" ? "M15 6 9 12l6 6" : "m9 6 6 6-6 6"} />
      </svg>
    </button>;
    const stamp = message.at === undefined ? null
      : <time className="message-time" dateTime={new Date(message.at).toISOString()} title={new Date(message.at).toLocaleString()}>{messageTime(message.at)}</time>;
    const held = expanded || goingBack?.message.seq === message.seq;
    const primary = [
      <button key="quote" type="button" className="msg-action quote" title="Quote" onClick={quote}
        aria-label={message.speaker.kind === "bot" ? `Quote response from ${names.get(message.speaker.id) ?? message.speaker.id}` : "Quote your message"}>
        <DeckIcon name="reply" size={18} />
      </button>,
      <button key="copy" type="button" className="msg-action copy" title="Copy" aria-label={copiedHere ? "Copied" : "Copy message"} onClick={copy}>
        {copiedHere ? <span className="copied">Copied</span> : <DeckIcon name="copy" size={16} />}
      </button>,
      canPin && <button key="pin" type="button" className="msg-action pin-action" title={pinLabel} aria-label={pinLabel} aria-pressed={pinned} disabled={unpinning} onClick={togglePin}>
        <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4Z" fill={pinned ? "currentColor" : "none"}/><path d="M12 16v6" /></svg>
      </button>,
    ];
    const extra = [
      goBackKind && <button key="goback" type="button" className={`msg-action ${goBackKind}`} disabled={busy} aria-label={goBackLabel} title={goBackHint} onClick={() => goBack(message)}>{goBackKind === "retry" ? retryIcon : revertIcon}</button>,
      onFork && <button key="fork" type="button" className="msg-action fork" aria-label="Fork from here" title="Fork from here" onClick={fork}>{forkIcon}</button>,
    ];
    // Your messages mirror a model's row: time, chevron, fork, revert, pin, copy, reply.
    const mine = message.speaker.kind === "human";
    const ordered = <T,>(items: T[]) => mine ? [...items].reverse() : items;
    return <span className={`message-actions collapsed-actions${held ? " held" : ""}`}>
      {mine && stamp}
      {mine && disclosure}
      {mine && expanded && <span className="message-action-items">{ordered(extra)}</span>}
      <span className="message-primary-actions">{ordered(primary)}</span>
      {!mine && expanded && <span className="message-action-items">{extra}</span>}
      {!mine && disclosure}
      {!mine && stamp}
      {goBackPop(message)}
    </span>;
  };
  /** Save the thread to Downloads as Markdown or JSON, then show the file. */
  const exportAs = (format: "markdown" | "json") => {
    const at = new Date();
    const thread: ThreadExport = { title: pane.title, participants, transcript: messagesOf(entries), pins, compaction: compactionOf(entries) };
    const contents = format === "json" ? exportJson(thread, at) : exportMarkdown(thread, at);
    backend.exportThread(exportFileName(pane.title, format, at), contents)
      .then((path) => { if (path) { notify(`Exported to ${path}`); openTarget(path, true); } })
      .catch((error) => notify(`Could not export: ${String(error)}`, "error"));
  };
  /** Commands run locally and never reach the models. */
  const runCommand = (command: Command) => {
    switch (command.name) {
      case "clear":
        if (busy || turnQueue.active) return notify("Wait for the models to finish before clearing the chat.");
        return clearChat();
      case "compact":
        return compactChat();
      case "fork":
        setText(""); return void forkAt(command.title || `${pane.title} (fork)`, null);
      case "export":
        setText(""); return exportAs(command.format);

      case "diff":
        setText(""); details?.show("changes"); loadDiff(); return;
      case "image": {
        // The picture is posted as your message, so every model can see it,
        // without asking anyone to reply.
        setText("");
        const who = command.provider.split(":")[0];
        const label = who === "grok" || who === "xai" ? "Grok" : who === "venice" ? "Venice" : "ChatGPT";
        notify(`Making a picture with ${label}…`);
        return void backend.generateImage(pane.id, command.provider, command.prompt)
          .then((path) => backend.roomPostTo(pane.id, withAttachments(`Picture from ${label}: ${command.prompt}`, [path]), []))
          .catch((error) => notify(`Could not make the picture: ${String(error)}`, "error"));
      }
      case "unknown":
        return notify(`${command.typed} isn't a command. Start with // to send it as a message.`, "error");

    }
  };
  // Fork or Export chosen in the pane's ⋯ menu.
  const lastMenu = useRef(menuRequest?.n ?? 0);
  useEffect(() => {
    if (!menuRequest || menuRequest.n === lastMenu.current) return;
    lastMenu.current = menuRequest.n;
    if (menuRequest.action === "fork") void forkAt(`${pane.title} (fork)`, null);
    else exportAs("markdown");
  }, [menuRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Artifacts: code from replies, opened on request, saved beside the thread.
  // A file that can't be read is never written over. See artifacts.ts.
  const [artifacts, setArtifacts] = useState<ArtifactFile>(EMPTY_ARTIFACTS);
  /** The newest file, ahead of the next render, so two changes in a row both land. */
  const latestArtifacts = useRef<ArtifactFile>(EMPTY_ARTIFACTS);
  const [artifactsLoaded, setArtifactsLoaded] = useState(false);
  const [artifactProblem, setArtifactProblem] = useState("");
  const [panel, setPanel] = useState<PanelView | null>(null);
  const mods = useMods();
  const modDock = mods.hostPane === pane.id ? mods.panes.filter((p) => !p.focus) : [];
  const artifactsReadable = useRef(false);
  const artifactSaves = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (profileMode) return;
    let live = true;
    artifactsReadable.current = false;
    setArtifactsLoaded(false);
    backend.artifactsLoad(pane.id).then(
      (raw) => {
        if (!live) return;
        latestArtifacts.current = readArtifacts(raw);
        setArtifacts(latestArtifacts.current);
        artifactsReadable.current = true;
        setArtifactProblem("");
        setArtifactsLoaded(true);
      },
      () => {
        if (!live) return;
        setArtifactProblem("Artifacts couldn't be read, so changes here won't be saved.");
        setArtifactsLoaded(true);
      },
    );
    return () => { live = false; };
  }, [backend, pane.id, profileMode]);

  const changeArtifacts = (next: ArtifactFile) => {
    latestArtifacts.current = next;
    setArtifacts(next);
    if (!artifactsReadable.current) return;
    artifactSaves.current = artifactSaves.current
      .then(() => backend.artifactsSave(pane.id, next))
      .then(() => setArtifactProblem(""), (error) => setArtifactProblem(`Couldn't save artifacts: ${String(error)}`));
  };

  // Files a bot wrote that the pane can show become artifacts when its turn
  // ends, or new versions of the ones already made from them. The pane opens
  // beside the chat to show them, without taking focus, unless that would get
  // in the way: the person closed it since their last message, is typing, the
  // window is too narrow to share, or auto-open is off. Then the Artifacts
  // button glows briefly and keeps a dot.
  const [unseenArtifacts, setUnseenArtifacts] = useState(0);
  const [artifactGlow, setArtifactGlow] = useState(0);
  useEffect(() => { if (panel) setUnseenArtifacts(0); }, [panel]);
  const panelWasOpen = useRef(false);
  const panelDismissed = useRef(false);
  useEffect(() => {
    if (panelWasOpen.current && !panel) panelDismissed.current = true;
    panelWasOpen.current = panel !== null;
  }, [panel]);
  const lastComposerKey = useRef(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (composer.current?.contains(event.target as Node)) lastComposerKey.current = Date.now(); };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  useEffect(() => {
    if (!artifactGlow) return;
    const timer = window.setTimeout(() => setArtifactGlow(0), 2200);
    return () => window.clearTimeout(timer);
  }, [artifactGlow]);
  const announceArtifact = (artifactId: string, n: number) => {
    const typing = Date.now() - lastComposerKey.current < 2000;
    if (panelWasOpen.current) { showVersion(artifactId, n); return; }
    if (artifactAutoOpen() && !panelDismissed.current && !typing && !narrow) { showVersion(artifactId, n); return; }
    setUnseenArtifacts((count) => count + 1);
    setArtifactGlow(Date.now());
  };
  collectWritten.current = (bot: string) => {
    const paths = [...written.current].filter(([path, by]) => by === bot && kindForPath(path)).map(([path]) => path);
    for (const path of paths) written.current.delete(path);
    if (paths.length === 0 || !artifactsReadable.current) return;
    for (const path of paths) {
      backend.workspaceRead(path, cwd || null).then((source) => {
        if (source === null) return;
        const out = upsertFromFile(latestArtifacts.current, path, { source, by: bot, seq: null, at: Date.now() }, `art-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
        if (!out.added) return;
        changeArtifacts(out.file);
        if (out.artifact) announceArtifact(out.artifact.id, out.artifact.versions.length);
      }, () => {});
    }
  };

  // HTML or SVG fenced in a live reply opens the same way. Replies loaded
  // with the thread don't: those were seen already.
  collectReply.current = (message) => {
    if (!artifactsReadable.current || message.speaker.kind !== "bot") return;
    const code = parseBlocks(message.text).flatMap((block) => (block.kind === "code" ? [{ language: block.language, text: block.text }] : []));
    if (code.length === 0) return;
    const out = fromReply(latestArtifacts.current, code, { source: "", by: message.speaker.id, seq: message.seq, at: Date.now() }, `art-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    if (!out.artifact) return;
    changeArtifacts(out.file);
    announceArtifact(out.artifact.id, 1);
  };

  const showVersion = (artifactId: string, n: number) => setPanel((view) => ({ ...(view ?? DEFAULT_VIEW), artifactId, n, list: false }));

  /** A person chose what to do with a code block in a finished reply. */
  const openFromCode = (message: { seq: number; speaker: Speaker }, code: { language: string; text: string }, choice: CodeChoice) => {
    if (choice.kind === "show") {
      showVersion(choice.artifactId, choice.n);
      return;
    }
    const version = { source: code.text, by: message.speaker.kind === "bot" ? message.speaker.id : null, seq: message.seq, at: Date.now() };
    if (choice.kind === "version") {
      const added = addVersion(latestArtifacts.current, choice.artifactId, version);
      if (added.n === 0) return;
      changeArtifacts(added.file);
      showVersion(choice.artifactId, added.n);
      return;
    }
    const kind = kindOf(code.language, code.text);
    if (!kind || code.text.length > MAX_SOURCE) return;
    const added = addArtifact(latestArtifacts.current, `art-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, kind, version);
    changeArtifacts(added.file);
    showVersion(added.artifact.id, 1);
  };

  const shownVersion = panel && !panel.list ? pickVersion(artifacts, panel.artifactId, panel.n) : null;
  /** The control for a code block in a finished bot reply, or nothing. */
  const artifactAction = (message: { seq: number; speaker: Speaker }, code: { language: string; text: string }) => {
    if (!artifactsLoaded) return null;
    const choices = codeChoices(artifacts, message.seq, code.language, code.text);
    if (!choices) return null;
    const showing = Boolean(shownVersion && choices.opened && shownVersion.artifact.id === choices.opened.artifactId && shownVersion.version.n === choices.opened.n);
    return <ArtifactButton choices={choices} showing={showing} onChoose={(choice) => openFromCode(message, code, choice)} />;
  };

  // In a narrow thread the panel covers the conversation.
  const chatBody = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = chatBody.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_PX));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The newest local server address a bot mentioned, for the chip in the pane
  // head. Only finished replies are messages; text still streaming is not, so
  // a half-written address never makes a chip.
  const newestServer = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.kind !== "message" || entry.message.speaker.kind !== "bot") continue;
      const found = findServerUrls(entry.message.text);
      if (found.length > 0) return found[found.length - 1];
    }
    return "";
  }, [entries]);
  useEffect(() => {
    // "" when no reply mentions one, as after /clear: the chip goes.
    if (!profileMode) onServer?.(pane.id, newestServer);
  }, [newestServer, onServer, pane.id, profileMode]);

  /** Save each file as soon as it is attached, so sending never waits. */
  const track = (name: string, preview: string | undefined, save: () => Promise<string>) => {
    const id = `${Date.now()}-${Math.random()}`;
    setAttached((list) => [...list, { id, name, preview }]);
    save()
      .then((path) => setAttached((list) => list.map((a) => (a.id === id ? { ...a, path } : a))))
      .catch((error) => {
        setAttached((list) => list.filter((a) => a.id !== id));
        if (preview) URL.revokeObjectURL(preview);
        notify(`Could not attach ${name}: ${String(error)}`, "error");
      });
  };
  const attachFiles = (files: Iterable<File>) => {
    for (const file of files) {
      const name = attachmentName(file.name, file.type);
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      track(name, preview, async () => backend.saveAttachment(pane.id, name, new Uint8Array(await file.arrayBuffer())));
    }
    input.current?.focus();
  };
  /** Ask for review: attach the thread's change as a patch for `id` and fill
   *  the composer with the request. It never sends. */
  const askForReview = (id: string, split: boolean) => {
    const files = diff?.files ?? [];
    const whole = reviewPatch(files);
    const parts = split ? reviewPatches(files) : whole ? [whole] : [];
    if (parts.length === 0) return;
    const taken = [...messagesOf(entries).filter((m) => m.speaker.kind === "human").map((m) => m.text), ...attached.map((a) => a.name)];
    const fileNames = reviewFileNames(nextReviewNumber(taken), parts.length);
    parts.forEach((text, i) => track(fileNames[i], undefined, () => backend.saveAttachment(pane.id, fileNames[i], new TextEncoder().encode(text))));
    setText((draft) => reviewDraft(id, draft));
    // In a narrow window the sidebar covers the composer; get it out of the way.
    if (details?.overlay) details.close();
    input.current?.focus();
  };
  const unattach = (id: string) => setAttached((list) => {
    const gone = list.find((a) => a.id === id);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    return list.filter((a) => a.id !== id);
  });
  // The desktop window takes file drops itself and reports their paths.
  const attachDropped = useRef<(paths: string[], x: number, y: number) => void>(() => {});
  attachDropped.current = (paths, x, y) => {
    const box = composer.current?.parentElement?.getBoundingClientRect();
    if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) return;
    for (const path of paths) {
      const name = path.replace(/\/+$/, "").split("/").pop() || path;
      track(name, undefined, () => backend.copyAttachment(pane.id, path));
    }
  };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let live = true;
    backend.onFileDrop((paths, x, y) => attachDropped.current(paths, x, y)).then((stop) => (live ? (unlisten = stop) : stop()));
    return () => { live = false; unlisten?.(); };
  }, [backend]);

  const [serverLists, setServerLists] = useState<Record<string, ToolServer[]>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [serverTargets, setServerTargets] = useState<string[]>([]);
  /** The text `serverTargets` was worked out for, so the recipient line never mixes a new draft with an old answer. */
  const [targetsText, setTargetsText] = useState("");
  useEffect(() => {
    if (!ready || !participants.length) return;
    let live = true;
    // Ask about the message as it will be sent, with a quote's leading handle.
    const outgoing = reply ? replyText(text, reply, participants.map((p) => p.id)) : text;
    // A slower answer for older text is ignored once the text has changed.
    backend.roomTargets(pane.id, outgoing).then(ids => { if (live) { setServerTargets(ids); setTargetsText(outgoing); } }).catch(() => {});
    return () => { live = false; };
  }, [backend, pane.id, text, reply, ready, participants]);
  const recipient = recipientLine({
    targets: serverTargets,
    roster: participants.map((p) => ({ id: p.id, name: p.display_name })),
    policy: options.policy,
    mentioned: hasMention(targetsText, participants.map((p) => p.id)),
    addressedBefore,
    busy: participants.filter((p) => working[p.id]).map((p) => p.id),
  });
  const serverMenuOpen = findTrigger(text, caret)?.kind === "server";
  useEffect(() => {
    if (!ready) return;
    let live = true;
    setServerLists({}); setServerErrors({});
    for (const p of participants) backend.listToolServers(pane.id, p.id).then(names => {
      if (live) setServerLists(lists => ({...lists, [p.id]: names}));
    }).catch(error => { if (live) setServerErrors(errors => ({...errors, [p.id]: String(error)})); });
    return () => { live = false; };
  }, [backend, pane.id, ready, participants, serverMenuOpen]);
  const requestedServers = parseServerRequests(text).map(s => s.name);
  const unknownServers = serverTargets.length && serverTargets.every(id => serverLists[id] !== undefined)
    ? resolveServerRequests(requestedServers, serverTargets.flatMap(id => serverLists[id])).unknown : [];

  const send = async (steer = false) => {
    panelDismissed.current = false;
    const targetIds = await backend.roomTargets(pane.id, text).catch(() => [] as string[]);
    const invalid = targetIds.length && targetIds.every(id => serverLists[id] !== undefined)
      ? resolveServerRequests(parseServerRequests(text).map(s => s.name), targetIds.flatMap(id => serverLists[id])).unknown : [];
    if (invalid.length) { notify(`No server, app or plugin called "${invalid[0]}" for ${targetIds.map(id => names.get(id) ?? id).join(", ")}`, "error"); return; }
    const body = text.trim();
    // A command a mod registered runs in the mod, never reaching the models.
    const modCommand = body && !sendable.length ? modHost.commandFor(body) : null;
    if (modCommand) {
      setText("");
      const out = await modHost.run(pane.id, modCommand, 100);
      if (out?.text) notify(out.text);
      return;
    }
    if ((!body && !sendable.length) || !ready || saving) return;
    const parsed = body ? parseComposer(body) : { text: "" };
    if ("command" in parsed) return runCommand(parsed.command);
    if (participants.length === 0) return;
    // Sending takes you to the bottom, where your message and the replies land,
    // and clears "New since you looked".
    stuck.current = true;
    setUnread(0);
    setDividerAt(null);
    // Mods allowed to see the session may rewrite the prompt or refuse it.
    const hooked = parsed.text ? await modHost.promptSubmit(pane.id, parsed.text) : { text: parsed.text };
    if (hooked.deny) { notify(hooked.deny, "error"); return; }
    const message = withTldr(withAttachments(hooked.text && replyText(postable(hooked.text), reply, participants.map((p) => p.id)), sendable.map((a) => a.path!)), tldr);
    if (tldr) wiggle(field.current);
    setText(""); setReply(null);
    attached.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
    setAttached([]);
    // ⌘↵ queues it, then steers it from the queue, so a cancelled prompt leaves it queued.
    void turnQueue.send(message).then(id => {
      const item = turnQueue.items.find(queuedItem => queuedItem.id === id);
      if (steer && item) askToSteer(item);
    }).catch(error => notify(String(error), "error"));
  };

  /** Put an example in the composer without sending it. */
  const insertExample = (example: string) => {
    const next = text.trim() ? `${text.trimEnd()} ${example}` : example;
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.length, next.length); });
  };
  const mention = (id: string) => {
    setText((t) => (t && !t.endsWith(" ") ? `${t} @${id} ` : `${t}@${id} `));
    input.current?.focus();
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const preset = PRESETS.find((p) => p.key === draft.preset)!;

  // Ask the tool for its own model list the first time its preset is shown.
  const tool = preset.agent?.tool;
  useEffect(() => {
    if (!adding || !tool || reported[tool]) return;
    let current = true;
    backend
      .agentModels(tool)
      .catch(() => [] as ModelChoice[])
      .then((models) => {
        if (current) setReported((r) => ({ ...r, [tool]: models }));
      });
    return () => {
      current = false;
    };
    // `reported` is read only to skip tools already asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding, tool]);

  const loadModels = async (baseUrl: string, keyEnv: string) => {
    if (!baseUrl.trim()) return setModelNote("Enter the base URL first.");
    setModelNote("Looking for models…");
    try {
      const found = await backend.apiModels(baseUrl.trim(), keyEnv.trim() || null);
      setApiModels(found);
      setModelNote(found.length ? `Found ${found.length} model${found.length === 1 ? "" : "s"}. Pick one or type a name.` : "The server answered but listed no models.");
      if (found.length) setDraft((d) => (d.model ? d : { ...d, model: found[0] }));
    } catch (error) {
      setApiModels([]);
      setModelNote(`Could not list models: ${String(error)}. You can still type a model name.`);
    }
  };

  const choosePreset = (key: PresetKey) => {
    const next = PRESETS.find((p) => p.key === key)!;
    // Only tools that enforce access themselves can stop and ask.
    setDraft((d) => ({ ...emptyDraft(key), appearance: d.appearance, name: d.name, persona: d.persona, access: d.access === "ask" && !next.agent?.asksFirst ? "read" : d.access }));
    // Model and effort names differ between backends, so they start empty.
    setApiModels([]);
    setModelNote("");
    setFormError("");
    if (next.api?.autoLoad) loadModels(next.api.baseUrl, "");
  };

  const agentGroups = preset.agent ? modelGroups(preset.agent.tool, reported[preset.agent.tool] ?? [], preset.label) : [];
  const typedBefore = preset.agent ? (rememberedModels()[preset.key] ?? []).filter((m) => !findModel(agentGroups, m)) : [];
  const modelChoices: PickerGroup[] = [
    { label: "Typed before", options: typedBefore.map((m) => ({ value: m, text: m })) },
    ...agentGroups.map((g) => ({ label: g.label, options: g.models.map((m) => ({ value: m.id, text: m.label ? `${m.id}  ·  ${m.label}` : m.id })) })),
  ];
  const chosenModel = findModel(agentGroups, draft.model);
  const efforts = preset.agent ? effortsFor(preset.efforts, agentGroups, draft.model) : preset.efforts;

  /** Pick a model, dropping an effort level the new model does not accept. */
  const setAgentModel = (model: string) =>
    setDraft((d) => {
      const known = findModel(agentGroups, model)?.efforts;
      return { ...d, model, effort: known && !known.includes(d.effort) ? "" : d.effort };
    });

  // The pane head's words (see headLine), and who is replying or stopped on a card, for App.
  const headBots: BotProgress[] = participants
    .filter((p) => working[p.id] && !asks[p.id]?.length)
    .map((p) => ({
      name: p.display_name,
      doing: doingNow(working[p.id]),
      startedAt: working[p.id].startedAt,
      heardAt: isCommandLine(p.backend) ? heard.current.get(p.id) ?? working[p.id].startedAt : null,
    }));
  const status: ThreadStatus = { ...threadStatusOf(participants, Object.keys(working), Object.keys(asks).filter((id) => asks[id].length > 0)), text: headLine(participants.length, headBots, now) };
  const statusKey = JSON.stringify(status);
  useEffect(() => { if (!profileMode) onStatus?.(pane.id, status); }, [statusKey]);
  // The title bar's + New agent opens the form here.
  useEffect(() => { if (profileMode && addRequest) openNewForm(); }, [addRequest]);

  // In the quick add menu the name follows the model until the person types one.
  useEffect(() => {
    if (!quickAdd || nameTouched.current) return;
    const tool = preset.agent?.tool ?? preset.key;
    const name = uniqueName(nameForModel(tool, preset.label, draft.model), participants.map((p) => p.id), slug);
    if (name !== draft.name) set("name", name);
  }, [quickAdd, draft.preset, draft.model, participants]);

  // Battery levels: context is each agent's own, the plan its provider's.
  const configOf = (id: string) => participants.find((p) => p.id === id);
  const levelsFor = (id: string): Levels => {
    const provider = planProvider(configOf(id));
    return { context: contextLevel(contextFill[id]), plan: provider ? planLevel(plans[provider]?.windows, Date.now() / 1000) : null };
  };
  const refillsFor = (id: string): Refills => {
    const provider = planProvider(configOf(id));
    return { context: compactions, plan: provider ? (plans[provider]?.resets ?? 0) : 0 };
  };
  /** Only each agent's newest reply shows live levels; older ones stay as they were drawn. */
  const newestReply = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.speaker.kind === "bot") newestReply.set(entry.message.speaker.id, entry.message.seq);
  }
  const canCompact = ready && !busy && participants.length > 0;

  /** The usage card for a chip: context, plan, session tokens, and a way to compact. */
  const usageCard = (p: ParticipantConfig) => {
    const fill = contextFill[p.id];
    const provider = planProvider(p);
    const windows = provider ? plans[provider]?.windows : undefined;
    const plan = windows ? planLine(windows, new Date()) : null;
    const reports = p.backend.kind === "agent" && p.backend.tool !== "gemini" && p.backend.tool !== "grok";
    const sharing = provider ? participants.filter((other) => planProvider(other) === provider).length : 0;
    return (
      <div className="usage-card" role="group" aria-label={`Usage for ${p.display_name}`}>
        <div className="usage-row">
          <span className="usage-label">Context</span>
          <span className={isLow(contextLevel(fill)) ? "usage-low" : undefined}>{fill ? contextLine(fill) : reports ? "Not reported yet. The next reply says." : "Not reported by this provider"}</span>
        </div>
        <div className="usage-row">
          <span className="usage-label">Plan</span>
          <span className={isLow(provider ? planLevel(windows, Date.now() / 1000) : null) ? "usage-low" : undefined}>
            {plan ?? (!provider ? "Not reported by this provider" : provider === "claude_code" ? "Known after a Claude Code reply" : "Not reported yet")}
          </span>
        </div>
        {provider && sharing > 1 && <p className="usage-note">Shared by all {AGENT_LABEL[provider]} agents in this room</p>}
        <p className="usage-note">{tokenLine(used[p.id])}</p>
        <button className="ghost usage-compact" onClick={() => { setCard(null); compactChat(); }} disabled={!canCompact} title="Summarize earlier turns so every model starts from the summary">
          Compact now
        </button>
      </div>
    );
  };

  const accessNote = preset.agent?.enforcesAccess
    ? "Enforced with the tool's own permission settings."
    : "Stated to the model as an instruction. Not enforced.";

  /** Open the full form for a new bot or agent. */
  function openNewForm() {
    details?.show("form");
    if (preset.api?.autoLoad && apiModels.length === 0) loadModels(draft.baseUrl, draft.keyEnv);
    if (!providerEnabled(draft.preset, disabledProviders)) setDraft(emptyDraft(firstPreset, defaults.current.newBotAccess));
    setEditing(null);
    setAdding(true);
  }
  /** Save a starter role as an agent, on the first coding agent that is installed. */
  const addStarter = (starter: typeof STARTERS[number]) => {
    const start = PRESETS.find((p) => p.key === firstPreset)!;
    const name = uniqueName(starter.name, participants.map((p) => p.id), slug);
    const built = draftToConfig({ ...emptyDraft(firstPreset), name, persona: starter.persona, access: starter.access === "ask" && !start.agent?.asksFirst ? "read" : starter.access });
    if (typeof built === "string") return notify(built, "error");
    const config = { ...built, appearance: createAppearance(participants.map((p) => appearance(p.id))) };
    const next = [...participants, config];
    setParticipants(next);
    onProfilesChange(next);
  };
  const addButton = (<button
            className="ghost"
            onClick={() => {
              if (adding) return closeForm(draft.preset);
              openNewForm();
            }}
            disabled={!ready || availablePresets.length === 0}
          >
            {adding ? "Cancel" : profileMode ? "+ New agent" : "+ Add model"}
          </button>);
  const modelForm = (adding && (
        <form
          className="add-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveParticipant();
          }}
        >
          {editing && <p className="form-title">Change settings for @{editing}</p>}
          <label>
            Name
            <input name="name" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Opus" autoFocus />
            {draft.name && <span className="hint">Mention as @{editing ?? slug(draft.name)}</span>}
          </label>
          {editing && <div className="appearance-controls">
            <Avatar seed={(draft.appearance ?? appearance(editing)).seed} color={(draft.appearance ?? appearance(editing)).color} />
            <label>Color<select aria-label="Agent color" value={(draft.appearance ?? appearance(editing)).color} onChange={e => set("appearance", { ...(draft.appearance ?? appearance(editing)), color: e.target.value })}>
              {AGENT_COLORS.map((c, i) => <option key={c} value={c}>{["Teal", "Amber", "Purple", "Pink", "Blue", "Lime", "Rose", "Cyan"][i]}</option>)}
            </select></label>
            <button type="button" className="ghost" onClick={() => set("appearance", { ...createAppearance([...identities.current.values()]), color: (draft.appearance ?? appearance(editing)).color })}>New pattern</button>
          </div>}
          <label>
            Connect through
            <select name="preset" value={draft.preset} onChange={(e) => choosePreset(e.target.value as PresetKey)}>
              {PRESETS.filter((p) => providerEnabled(p.key, disabledProviders) || (editing && p.key === draft.preset)).map((p) => (
                <option key={p.key} value={p.key} disabled={!installed(p)}>
                  {p.label}
                  {installed(p) ? "" : " (not installed)"}
                </option>
              ))}
            </select>
          </label>
          {preset.agent && (
            <label>
              Model
              <Picker
                key={`model:${draft.preset}:${editing ?? "new"}`}
                name="agent-model"
                value={draft.model}
                onChange={setAgentModel}
                groups={modelChoices}
                emptyLabel={`Default (whatever ${preset.label} is set to)`}
                customLabel="Type another model name…"
                customPlaceholder="Exact model name"
              />
              <span className="hint">
                {preset.agent.modelNote}
                {chosenModel?.note ? ` ${chosenModel.note}` : ""}
              </span>
            </label>
          )}
          {preset.api && (
            <>
              <label>
                Base URL
                <input name="base-url" value={draft.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="e.g. https://api.example.com/v1" />
              </label>
              <label>
                Model
                <span className="row">
                  <input name="model" list={`models-${pane.id}`} value={draft.model} onChange={(e) => set("model", e.target.value)} placeholder="e.g. llama3" />
                  <button type="button" className="ghost" onClick={() => loadModels(draft.baseUrl, draft.keyEnv)}>
                    List models
                  </button>
                </span>
                <datalist id={`models-${pane.id}`}>
                  {apiModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                {modelNote && <span className="hint">{modelNote}</span>}
              </label>
              {draft.preset === "api" && (
                <label>
                  API key variable
                  <input name="key-env" value={draft.keyEnv} onChange={(e) => set("keyEnv", e.target.value)} placeholder="e.g. MY_PROVIDER_API_KEY" />
                  <span className="hint">The name of an environment variable holding the key. The key itself is never stored.</span>
                </label>
              )}
            </>
          )}
          {draft.preset === "command" && (
            <label className="wide">
              Command
              <input name="command" value={draft.command} onChange={(e) => set("command", e.target.value)} placeholder="e.g. mytool --print" />
              <span className="hint">Runs once per turn in the workspace folder. The conversation is written to its standard input and its output becomes the reply.</span>
            </label>
          )}
          {preset.efforts.length > 0 && (
            <label>
              Reasoning effort
              {efforts.length > 0 ? (
                <Picker
                  key={`effort:${draft.preset}:${editing ?? "new"}`}
                  name="effort"
                  value={draft.effort}
                  onChange={(level) => set("effort", level.trim().toLowerCase())}
                  groups={[{ label: "", options: efforts.map((level) => ({ value: level, text: effortLabel(level) })) }]}
                  emptyLabel="Default"
                  customLabel="Type another level…"
                  customPlaceholder="e.g. high"
                />
              ) : (
                <select name="effort" disabled>
                  <option>Not available for this model</option>
                </select>
              )}
              <span className="hint">
                {efforts.length > 0
                  ? chosenModel
                    ? "These are the levels this model accepts. Higher levels think longer and cost more."
                    : "Higher levels think longer and cost more. Not every model accepts every level."
                  : "This model has no effort setting."}
              </span>
            </label>
          )}
          {draft.preset !== "scripted" && (
            <label>
              Access
              <select name="access" value={draft.access} onChange={(e) => set("access", e.target.value as Access)}>
                <option value="read">Read only</option>
                {preset.agent?.asksFirst && <option value="ask">Ask first (you approve each edit and command)</option>}
                <option value="edits">Can edit files</option>
                <option value="full">Full access (edits and runs commands without asking)</option>
              </select>
              <span className="hint">{accessNote}</span>
            </label>
          )}
          <label className="wide">
            Persona (optional)
            <textarea name="persona" value={draft.persona} onChange={(e) => set("persona", e.target.value)} rows={2} placeholder="e.g. You are the reviewer. Look for bugs and be brief." />
          </label>
          {formError && <p className="form-error">{formError}</p>}
          <button className="primary" type="submit">
            {editing ? "Save changes" : profileMode ? "Save agent" : "Add to chat"}
          </button>
        </form>
      ));
  const addSaved = async (config: ParticipantConfig) => {
    try {
      await backend.roomAddParticipant(pane.id, config);
      setParticipants((list) => [...list, config]);
      return true;
    } catch (error) { notify(`Could not add the agent: ${String(error)}`, "error"); return false; }
  };
  const openQuickAdd = (where: "empty" | "details" | "roster") => {
    if (quickAdd === where) return setQuickAdd(null);
    nameTouched.current = false;
    setEditing(null);
    setAdding(false);
    setFormError("");
    const start = providerEnabled(draft.preset, disabledProviders) && installed(preset) ? draft.preset : firstPreset;
    setDraft({ ...emptyDraft(start), access: draft.access });
    const startPreset = PRESETS.find((p) => p.key === start);
    if (startPreset?.api?.autoLoad) loadModels(startPreset.api.baseUrl, "");
    setQuickAdd(where);
  };
  /** Up to three tools for the quick menu: installed coding agents, then local models. */
  const quickTools = availablePresets.filter((p) => (p.agent && installed(p)) || p.key === "ollama").slice(0, 3);
  const quickAddMenu = (
    <form className="quick-add" aria-label="Add a bot" onSubmit={async (e) => { e.preventDefault(); if (await saveParticipant()) setQuickAdd(null); }}>
      {availableProfiles.some((p) => !participants.some((own) => own.id === p.id)) && <>
        <span className="quick-add-label">Saved agents</span>
        <div className="quick-add-saved">
          {availableProfiles.filter((p) => !participants.some((own) => own.id === p.id)).map((p) => (
            <button type="button" key={p.id} className="quick-add-chip" style={{ borderColor: (p.appearance ?? legacyAppearance(p.id)).color }} onClick={async () => { if (await addSaved(p)) setQuickAdd(null); }}>{p.display_name}</button>
          ))}
        </div>
        <span className="quick-add-label">Or a new bot</span>
      </>}
      <div className="quick-add-tools" role="radiogroup" aria-label="Tool">
        {quickTools.map((p) => <button type="button" role="radio" aria-checked={draft.preset === p.key} key={p.key} className={draft.preset === p.key ? "on" : undefined} onClick={() => choosePreset(p.key)}>{p.label.replace(/\s*\(.*\)$/, "")}</button>)}
        <button type="button" onClick={() => { setQuickAdd(null); details?.show("form"); setAdding(true); }}>More…</button>
      </div>
      <div className="quick-add-grid">
        <label>Model
          {preset.agent ? (
            <Picker key={`quick-model:${draft.preset}`} name="quick-model" value={draft.model} onChange={setAgentModel} groups={modelChoices} emptyLabel="Default" customLabel="Type another model name…" customPlaceholder="Exact model name" />
          ) : (
            <><input name="quick-model" list={`quick-models-${pane.id}`} value={draft.model} onChange={(e) => set("model", e.target.value)} placeholder="e.g. llama3" />
              <datalist id={`quick-models-${pane.id}`}>{apiModels.map((m) => <option key={m} value={m} />)}</datalist></>
          )}
        </label>
        <label>Access
          <select name="quick-access" value={draft.access} onChange={(e) => set("access", e.target.value as Access)}>
            <option value="read">Read only</option>
            {preset.agent?.asksFirst && <option value="ask">Ask first</option>}
            <option value="edits">Can edit files</option>
            <option value="full">Full access</option>
          </select>
        </label>
      </div>
      <label>Name
        <input name="quick-name" value={draft.name} onChange={(e) => { nameTouched.current = true; set("name", e.target.value); }} placeholder="e.g. Opus" />
        {draft.name && <span className="hint">Mention as @{slug(draft.name)}</span>}
      </label>
      {formError && <p className="form-error">{formError}</p>}
      <div className="quick-add-foot">
        <button type="button" className="ghost" onClick={() => { setQuickAdd(null); details?.show("form"); setAdding(true); }}>More options</button>
        <button className="primary" type="submit">Add to chat</button>
      </div>
    </form>
  );
  const quickAddButton = (where: "empty" | "details" | "roster", primary: boolean) => (
    <span className={`quick-add-wrap ${where}`}>
      <button className={primary ? "primary" : "ghost"} disabled={!ready || (availablePresets.length === 0 && availableProfiles.length === 0)} aria-haspopup="dialog" aria-expanded={quickAdd === where} onClick={() => openQuickAdd(where)}>+ Add bot</button>
      {quickAdd === where && quickAddMenu}
    </span>
  );
  const roomControls = (<div className="chat-options">
          <label>
            Who answers
            <select disabled={!ready || busy} value={options.policy} onChange={(e) => changeOptions({ ...options, policy: e.target.value as TurnPolicy })}>
              {REPLY_POLICIES.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          </label>
          <div className="stepper-field" title="How many rounds of models answering each other are allowed after one of your messages">
            <span id={`rounds-${pane.id}`}>Model-to-model rounds</span>
            <span className="stepper">
              <button type="button" aria-label="Fewer rounds" disabled={!ready || busy || options.max_bot_hops <= 0} onClick={() => changeOptions({ ...options, max_bot_hops: Math.max(0, options.max_bot_hops - 1) })}>−</button>
              <input
                type="number"
                min={0}
                max={10}
                aria-labelledby={`rounds-${pane.id}`}
                value={options.max_bot_hops}
                disabled={!ready || busy}
                onChange={(e) => changeOptions({ ...options, max_bot_hops: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
              />
              <button type="button" aria-label="More rounds" disabled={!ready || busy || options.max_bot_hops >= 10} onClick={() => changeOptions({ ...options, max_bot_hops: Math.min(10, options.max_bot_hops + 1) })}>+</button>
            </span>
          </div>
          <label>
            Confirm before steering
            <select value={steerChoice} onChange={(e) => chooseSteer(e.target.value as ThreadSteer)}>
              <option value="global">Use Settings ({confirmSteer ? "ask" : "don't ask"})</option>
              <option value="ask">Always ask</option>
              <option value="never">Never ask</option>
            </select>
          </label>
        </div>);
  const pinControls = (pins.length > 0 ? <details className="pins" aria-label="Pinned for every model">
        <summary className="pins-label">Pinned <span>({pins.length})</span></summary>
        <div className="pins-list">
        {pins.map((pin, index) => <div className="pin" key={pin}>
          {pinSource(pin) !== null ? <button className="pin-text pin-jump" title={pinText(pin)} onClick={() => scroller.current?.querySelector<HTMLElement>(`[data-seq="${pinSource(pin)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>{pinText(pin)}</button> : <span className="pin-text" title={pin}>{pin}</span>}
          <button className="icon small" aria-label={`Unpin ${pin}`} disabled={unpinning} onClick={() => removePin(index)}>×</button>
        </div>)}
        </div>
      </details> : <p className="muted">No pinned responses. Use the pin icon on a model response.</p>);
  const accessLabel = (access: Access) => access === "read" ? "Read only" : access === "ask" ? "Ask first" : access === "edits" ? "Can edit files" : "Full access";
  /** A small labelled bar for a context or plan reading. */
  const meter = (name: string, level: number | null) => level === null ? null : <span className="bot-meter" title={name === "ctx" ? "Context left" : "Plan left"}>
    {name}<span className="bot-meter-track" aria-hidden="true"><span style={{ width: `${percent(level)}%` }} className={isLow(level) ? "low" : undefined} /></span>
    {percent(level)}%{isLow(level) && <span className="usage-low"> low</span>}
  </span>;
  const botControls = <>{participants.map(p => {
    const levels = levelsFor(p.id);
    return <article className="details-bot" key={p.id}>
      <div className="details-bot-row">
        <Avatar seed={appearance(p.id).seed} color={color(p.id)} levels={levels} refills={refillsFor(p.id)} working={Boolean(working[p.id]) && !asks[p.id]?.length} />
        <div className="details-bot-copy">
          <strong style={{ color: color(p.id) }}>{p.display_name}</strong>
          <span className="muted">{describe(p).replace(" · asks first", "")} · {accessLabel(p.access)}</span>
          {(levels.context !== null || levels.plan !== null) && <span className="bot-meters">{meter("ctx", levels.context)}{meter("plan", levels.plan)}</span>}
        </div>
        <span className="pane-menu-wrap">
          <button className="icon small" aria-label={`Actions for ${p.display_name}`} aria-haspopup="menu" aria-expanded={botMenu === p.id} onClick={() => setBotMenu(open => open === p.id ? null : p.id)}>⋯</button>
          {botMenu === p.id && <span className="pane-menu" role="menu">
            <button role="menuitem" disabled={busy} aria-label={`Change settings for ${p.display_name}`} onClick={() => { setBotMenu(null); details?.show("form"); startEditing(p); }}>Edit</button>
            <button role="menuitem" disabled={busy} aria-label={`Save ${p.display_name} to Agents`} onClick={() => { setBotMenu(null); onProfilesChange([...profiles.filter(profile => profile.id !== p.id), p]); }}>Save to Agents</button>
            <span className="pane-menu-sep" role="separator" />
            <button role="menuitem" className="danger-text" disabled={busy} aria-label={`Remove ${p.display_name}`} onClick={() => { setBotMenu(null); removeParticipant(p.id); }}>Remove</button>
          </span>}
        </span>
      </div>
      <details className="details-bot-usage"><summary>Usage</summary>{usageCard(p)}</details>
    </article>;
  })}{adding && !editing ? addButton : quickAddButton("details", false)}</>;
  /** Take an Always allow back. The bot asks again next time. */
  const forgetRule = (rule: AllowedRule) => backend.roomForgetAllowed(pane.id, rule)
    .then(() => setRemovedNote(removedLine(names.get(rule.by) ?? rule.by)))
    .catch((error) => notify(`Could not remove it: ${String(error)}`, "error"));
  const allowedList = <>
    {allowed.length === 0
      ? <p className="muted allowed-empty">Nothing yet. Choose Always allow on an approval card and it shows here, so you can take it back.</p>
      : <ul className="allowed-list" aria-label="Always allowed">
        {allowed.map((rule) => <li key={`${rule.by}\u001f${rule.kind}\u001f${rule.what}`}>
          <span className="allowed-copy">
            <strong style={{ color: color(rule.by) }}>{names.get(rule.by) ?? rule.by}</strong>
            <span className={`allowed-what${rule.kind === "command" || rule.kind === "tool" ? " mono" : ""}`} title={rule.what}>{describeRule(rule)}</span>
            <span className="allowed-when">{allowedLine(rule, new Date())}</span>
          </span>
          <button className="ghost small" aria-label={`Stop always allowing ${describeRule(rule)} for ${names.get(rule.by) ?? rule.by}`} onClick={() => void forgetRule(rule)}>Remove</button>
        </li>)}
      </ul>}
    {removedNote && <p className="allowed-removed" role="status"><span aria-hidden="true">✓</span>{removedNote}</p>}
  </>;
  return (
    <div ref={root} className={`chat ${profileMode ? "" : "thread-chat"}`}>
      {quickAdd === "roster" && rosterAnchor && <span className="quick-add-wrap roster-pop" style={{ left: rosterAnchor.left, top: rosterAnchor.top }}>{quickAddMenu}</span>}
      {quickSettings && participants.find(p => p.id === quickSettings.id) && <BotSettings key={quickSettings.id} config={participants.find(p => p.id === quickSettings.id)!} anchor={quickSettings.anchor} backend={backend} close={closeQuickSettings} avatar={<Avatar seed={appearance(quickSettings.id).seed} color={color(quickSettings.id)} working={Boolean(working[quickSettings.id]) && !asks[quickSettings.id]?.length} levels={levelsFor(quickSettings.id)} refills={refillsFor(quickSettings.id)} />} meters={(() => { const levels = levelsFor(quickSettings.id); const now = Date.now() / 1000; const row = (name: string, level: number | null, title: string, resetsAt?: number | null, used = false) => { const shown = level === null ? null : used ? 1 - level : level; return <span key={title} className="bot-meter" title={resetsAt != null ? `${title} · resets ${resetDate(resetsAt)}` : title}>{name}<span className="bot-meter-track" aria-hidden="true">{shown !== null && <span style={{ width: `${percent(shown)}%` }} className={isLow(level!) ? "low" : undefined} />}</span>{shown === null ? "—" : `${percent(shown)}%`}<span className="bot-meter-timer">{resetsAt != null ? countdown(resetsAt, now) : ""}</span></span>; }; const provider = planProvider(configOf(quickSettings.id)); const windows = provider ? liveWindows(plans[provider]?.windows ?? [], now) : []; return <span className="bot-meters">{row("ctx", levels.context, "Context used", null, true)}{windows.length ? windows.map(w => row(w.window_minutes === 10_080 ? "wk" : w.window_minutes === 300 ? "5h" : windowLabel(w), 1 - Math.min(100, w.used_percent) / 100, `${windowLabel(w)} limit left`, w.resets_at)) : row("plan", levels.plan, "Plan left")}</span>; })()} save={async config => {
        await backend.roomUpdateParticipant(pane.id, config);
        setParticipants(list => list.map(p => p.id === config.id ? config : p));
        if (turnQueue.state[config.id] === "working") setPendingSettings(all => ({ ...all, [config.id]: true }));
      }} /> }
      {!profileMode && details?.target === pane.id && details.open && details.slot && createPortal(<ThreadDetails host={details} title={pane.title} cwd={cwd} subtitle={[workspaceName, participants.length === 1 ? "1 bot" : `${participants.length} bots`].filter(Boolean).join(" · ")} bots={botControls} form={modelForm} room={roomControls} allowed={allowedList} changes={<DiffPanel diff={diff} loading={diffLoading} order={participants.map(p => p.id)} onRefresh={loadDiff} nameOf={id => names.get(id) ?? id} colorOf={color} appearanceOf={appearance} onReveal={path => openTarget(path, true)} reviewers={reviewerRows(participants)} onReview={askForReview} />} />, details.slot)}
      <div className="chat-bar">
        <div className="chips">
          {!profileMode && participants.map((p) => {
            const levels = levelsFor(p.id);
            return (
            <span
              className="chip-wrap"
              key={p.id}
              onMouseEnter={() => setCard(p.id)}
              onMouseLeave={() => setCard((open) => (open === p.id ? null : open))}
              onFocus={() => setCard(p.id)}
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCard((open) => (open === p.id ? null : open)); }}
              onKeyDown={(e) => { if (e.key === "Escape") setCard(null); }}
            >
            <span className="chip" style={{ borderColor: color(p.id) }}>
              <button className="chip-name" aria-haspopup={p.backend.kind === "agent" || p.backend.kind === "open_ai_compatible" ? "dialog" : undefined} aria-expanded={quickSettings?.id === p.id} onClick={(event) => {
                if (p.backend.kind === "agent" || p.backend.kind === "open_ai_compatible") {
                  setCard(null);
                  setQuickSettings(quickSettings?.id === p.id ? null : { id: p.id, anchor: event.currentTarget });
                } else mention(p.id);
              }} title={`Model and reasoning for ${p.display_name}`}>
                <Avatar seed={appearance(p.id).seed} color={color(p.id)} size="sm" working={Boolean(working[p.id]) && !asks[p.id]?.length} levels={levels} refills={refillsFor(p.id)} />
                <span className={`participant-status ${working[p.id]?.phase ?? "idle"}`} aria-label={`${p.display_name}: ${working[p.id]?.phase ?? "idle"}`} />
                {p.display_name}
                {pendingSettings[p.id] && <span className="settings-pending" role="status" aria-label="Settings pending for next reply" title="Settings apply to the next reply" />}
                {queued.some(item => item.to.includes(p.id)) && <span className="chip-meta">{queued.filter(item => item.to.includes(p.id)).length} queued</span>}
                {editor === p.id && <span className="editor-badge">editing</span>}
                <span className="chip-meta chip-description">{describe(p)}</span>
                {(levels.context !== null || levels.plan !== null) && (
                  <span className="chip-meta chip-levels">
                    {levels.context !== null && <span title="Context left">ctx {percent(levels.context)}%{isLow(levels.context) && <span className="usage-low"> low</span>}</span>}
                    {levels.context !== null && levels.plan !== null && <span className="chip-sep" aria-hidden="true">·</span>}
                    {levels.plan !== null && <span title="Plan left">plan {percent(levels.plan)}%{isLow(levels.plan) && <span className="usage-low"> low</span>}</span>}
                  </span>
                )}
              </button>

            </span>
            {card === p.id && !quickSettings && usageCard(p)}
            </span>
            );
          })}
          {/* An empty library offers its own button inside the starter card. */}
          {profileMode && (participants.length > 0 || adding) && addButton}
          {!profileMode && participants.length > 0 && (
            <span className="quick-add-wrap roster">
              <button className="chip-add" disabled={!ready} aria-label="Add a bot" title="Add a bot" aria-haspopup="dialog" aria-expanded={quickAdd === "roster"} onClick={(e) => { if (availablePresets.length === 0 && availableProfiles.length === 0) { details?.show("form"); setAdding(true); } else { const r = e.currentTarget.getBoundingClientRect(); setRosterAnchor({ left: r.left, top: r.bottom + 8 }); openQuickAdd("roster"); } }}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
            </span>
          )}
        </div>



        {!profileMode && <div className="thread-counts">{artifacts.artifacts.length > 0 && <button key={artifactGlow || undefined} className={`ghost small${panel ? " on" : ""}${artifactGlow ? " artifact-glow" : ""}`} aria-pressed={panel !== null} onClick={() => setPanel((view) => (view ? null : DEFAULT_VIEW))}>Artifacts · {artifacts.artifacts.length}{unseenArtifacts > 0 && !panel && <span className="new-dot" aria-label={`${unseenArtifacts} new`} />}</button>}{changes.length > 0 && <button className="ghost small" onClick={() => { details?.show("changes"); loadDiff(); }}>Changes · {new Set(changes.map(c => c.change.path)).size}</button>}</div>}
      </div>

      {!profileMode && pins.length > 0 && pinControls}

      {profileMode && modelForm}

      {profileMode && <div className="agent-library">
        {participants.length === 0 && !adding && <div className="empty agents-empty">
          <h3>Create your first agent</h3>
          <p>Start from a role and change anything later, or build one from scratch.</p>
          <div className="starters">
            {STARTERS.map((starter) => <button key={starter.name} disabled={availablePresets.length === 0} onClick={() => addStarter(starter)}>
              <strong>{starter.name}</strong><span>{starter.note} {starter.access === "ask" ? "Asks first." : "Read only."}</span>
            </button>)}
          </div>
          <div className="starters-foot">
            <span className="muted">Or save a bot from a thread with Save to Agents.</span>
            <button className="primary" onClick={openNewForm} disabled={availablePresets.length === 0}>+ New agent</button>
          </div>
        </div>}
        {participants.map((p) => <article className="agent-card" key={p.id}>
          <Avatar seed={appearance(p.id).seed} color={color(p.id)} size="lg" />
          <div className="agent-card-copy"><h2>{p.display_name}</h2><p className="muted">{describe(p)}</p><p>{p.persona || "No brief added yet."}</p><span className="hint">@{p.id} · {p.access === "read" ? "Read only" : p.access === "ask" ? "Asks first" : p.access === "edits" ? "Can edit files" : "Full access"}</span></div>
          <div className="agent-card-actions"><button onClick={() => startEditing(p)}>Edit</button><button className="ghost" onClick={() => removeParticipant(p.id)} aria-label={`Delete agent ${p.display_name}`}>Delete</button></div>
        </article>)}
      </div>}

      <div className="chat-body" ref={chatBody}>
      {!profileMode && <div className="transcript" ref={scroller} onScroll={() => { setPicked(null); onTranscriptScroll(); }}
        onMouseUp={() => requestAnimationFrame(pickSelection)} onKeyUp={(e) => e.shiftKey && pickSelection()}
        onMouseDown={(e) => { if (!(e.target as Element).closest(".selection-actions")) setPicked(null); }}>
        {picked && <span className="selection-actions" role="toolbar" aria-label="Selected text" style={{ left: picked.x, top: picked.y }}>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={addPicked}>Add to chat</button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={explainPicked} disabled={!ready || participants.length === 0}>More details</button>
        </span>}
        {entries.length === 0 && Object.keys(drafts).length === 0 && (
          <div className="empty">
            <div className="empty-emblem"><DeckIcon name="chat" size={26} /></div>
            <span className="eyebrow">A fresh perspective starts here</span>
            <h3>{participants.length === 0 ? "Build your thinking team." : "The room is yours."}</h3>
            <p>
              {participants.length === 0
                ? "Add two or more models, then ask them something. Each one sees the whole conversation."
                : "Type a message below. Use @name to pick who answers, or @all for everyone."}
            </p>
            {participants.length === 0 && quickAddButton("empty", true)}
            {participants.length > 0 && <div className="example-rows" aria-label="Examples">
              {exampleRows(participants.map((p) => p.id)).map((row) => (
                <button key={row.text} type="button" className="example-row" onClick={() => insertExample(row.text)}>{row.label}</button>
              ))}
            </div>}
          </div>
        )}
        {entries.flatMap((entry) => {
          const item = entry.kind === "notice" ? (
            <p key={`n${entry.notice.key}`} className={`notice ${entry.notice.tone}${entry.notice.action ? " with-action" : ""}`}>
              <span>{entry.notice.text}</span>
              {entry.notice.action && noticeButton(entry.notice.key, entry.notice.action)}
            </p>
          ) : entry.kind === "low" ? (
            <p key={`l${entry.low.key}`} className="notice low-context">
              <span>{names.get(entry.low.id) ?? entry.low.id} is down to {entry.low.left}% context. Compacting summarizes earlier turns and refills it.</span>
              <button className="ghost" onClick={compactChat} disabled={!canCompact}>Compact</button>
            </p>
          ) : entry.kind === "summary" ? (
            <details key={`s${entry.summary.upto}`} className="compacted">
              <summary>
                {entry.summary.by ? `Summarized by ${names.get(entry.summary.by) ?? entry.summary.by}` : "Summarized"} · the models see this instead of the messages above
              </summary>
              <Markdown text={entry.summary.summary} onOpen={openTarget} pathExists={pathExists} />
            </details>
          ) : entry.message.speaker.kind === "human" ? (
            <div key={`m${entry.message.seq}`} className="message-row human-row" data-seq={entry.message.seq}>
              {messageActions(entry.message)}
              <div className="bubble human">
                <RichText text={splitTldr(entry.message.text).text} onOpen={openTarget} />
                <AttachedImages paths={attachedImages(entry.message.text)} read={backend.readAttachment} onOpen={(path) => openTarget(path, true)} />
              </div>
            </div>
          ) : (
            <div key={`m${entry.message.seq}`} className="bot-row message-row">
              <Avatar
                seed={appearance(entry.message.speaker.id).seed}
                color={color(entry.message.speaker.id)}
                {...(newestReply.get(entry.message.speaker.id) === entry.message.seq ? { levels: levelsFor(entry.message.speaker.id), refills: refillsFor(entry.message.speaker.id) } : {})}
              />
              <div className="bubble bot completed" data-seq={entry.message.seq}>
                <span className="speaker" style={{ color: color(entry.message.speaker.id) }}>
                  {names.get(entry.message.speaker.id) ?? entry.message.speaker.id}
                </span>
                <Markdown text={entry.message.text} onOpen={openTarget} pathExists={pathExists} codeAction={(code) => artifactAction(entry.message, code)} />
                <AttachedImages paths={replyImages(entry.message.text)} read={readReplyImage} onOpen={(path) => openTarget(path, true)} />
              </div>
              {messageActions(entry.message)}
            </div>
          );
          // "New since you looked" goes above the first reply you have not seen.
          return entry.kind === "message" && entry.message.seq === dividerAt
            ? [<div key={`u${entry.message.seq}`} className="unseen-divider" role="separator" aria-label="New since you looked"><span>New since you looked</span></div>, item]
            : [item];
        })}
        {Object.entries(drafts).map(([id, partial]) => {
          const turn = working[id];
          const steps = turn?.steps ?? [];
          // Long turns take many steps; the latest few say where it is.
          const shown = steps.slice(-MAX_STEPS_SHOWN);
          const hidden = steps.length - shown.length;
          const config = configOf(id);
          const quiet = turn && !asks[id]?.length && config && isCommandLine(config.backend) ? quietLine(heard.current.get(id) ?? turn.startedAt, now) : null;
          return (
            <div key={`d${id}`} className="bot-row">
              <Avatar seed={appearance(id).seed} color={color(id)} working={!asks[id]?.length} levels={levelsFor(id)} refills={refillsFor(id)} />
              <div className="bubble bot writing" aria-busy="true">
                <span className="speaker" style={{ color: color(id) }}>
                  {names.get(id) ?? id}
                </span>
                {steps.length > 0 && (
                  <ul className="steps" aria-label="Steps so far">
                    {hidden > 0 && <li className="step done">{hidden === 1 ? "1 earlier step" : `${hidden} earlier steps`}</li>}
                    {shown.map((step, i) => (
                      <li key={steps.length - shown.length + i} className={`step ${i === shown.length - 1 && turn?.phase === "tool" ? "current" : "done"}`}>
                        {step}
                      </li>
                    ))}
                  </ul>
                )}
                {partial && (
                  <div className="draft-text">
                    <Markdown text={partial} onOpen={openTarget} />
                  </div>
                )}
                {(asks[id] ?? []).map((ask) => (
                  <ApprovalCard
                    key={ask.request}
                    request={ask.request}
                    by={id}
                    action={ask.action}
                    name={names.get(id) ?? id}
                    deadline={deadlineNote(ask.action.expires_at, now)}
                    onDecide={(approve, always) => {
                      backend.roomDecide(pane.id, ask.request, approve, always).catch((error) => notify(`Could not send your answer: ${String(error)}`, "error"));
                    }}
                  />
                ))}
                <div className={`working-line ${asks[id]?.length ? "asking" : quiet ? "quiet" : ""}`} role="status">
                  <span className="working-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>{asks[id]?.length ? "Waiting for you" : quiet ?? phaseLabel(turn?.phase)}</span>
                  {turn && !quiet && <span className="working-time">{elapsed(now - turn.startedAt)}</span>}
                  {turn && <button type="button" className="bubble-stop" aria-label={`Stop ${names.get(id) ?? id}`} title={`Stop ${names.get(id) ?? id}`} onClick={() => void turnQueue.halt(id)}><StopSquare /> Stop</button>}
                </div>
              </div>
            </div>
          );
        })}
        {queued.map((item) => {
          const who = item.to.map((id) => names.get(id) ?? id).join(", ");
          const steerable = item.kind === "message" && item.to.some((id) => working[id]);
          return <div key={`q${item.id}`} className="queued-inline">
            {editingQueued === item.id
              ? <textarea className="q-edit" aria-label={`Edit queued message ${item.id}`} autoFocus rows={2} defaultValue={item.text}
                  onKeyDown={(e) => { if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); e.currentTarget.blur(); } }}
                  onBlur={(e) => {
                    setEditingQueued(null);
                    if (e.target.value === item.text) return;
                    const parsed = parseQueueEdit(e.target.value);
                    if ("text" in parsed) turnQueue.edit(item.id, parsed.text);
                    else if (parsed.command.name === "compact") turnQueue.edit(item.id, "/compact", "compact");
                    else { turnQueue.remove(item.id); setText(e.target.value); runCommand(parsed.command); }
                  }} />
              : <button type="button" className="q-text" title="Edit" onClick={() => setEditingQueued(item.id)}>{splitTldr(item.text).text}</button>}
            <div className="q-meta">
              <span className="q-for">{queuePaused ? "Paused for" : "Queued for"} {item.to.slice(0, 1).map((id) => <Avatar key={id} seed={appearance(id).seed} color={color(id)} size="sm" />)}<span>{who}</span></span>
              {queuePaused && <><i className="q-sep" /><button type="button" onClick={() => { setQueuePaused(false); turnQueue.resume(); }}>Resume</button></>}
              {steerable && <><i className="q-sep" /><button type="button" title={`Send to ${who} now, mid-turn (⌘↵)`} onClick={() => askToSteer(item)}>Steer <SteerArrow /></button></>}
              <i className="q-sep" />
              <button type="button" className="q-trash" aria-label="Remove queued message" title="Remove" onClick={() => turnQueue.remove(item.id)}><TrashIcon /></button>
              {steerAsking === item.id && <div className="steer-pop" role="dialog" aria-label="Steer now?"
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); answerSteer(item, "cancel"); } }}>
                <strong>Steer interrupts {who} mid-turn.</strong>
                <p>It may leave work half-done. Change this later in Thread details or Settings.</p>
                <div className="row">
                  <button type="button" className="primary small" autoFocus onClick={() => answerSteer(item, "once")}>Allow once</button>
                  <button type="button" className="ghost small" onClick={() => answerSteer(item, "thread")}>Always in this thread</button>
                  <button type="button" className="ghost small" onClick={() => answerSteer(item, "always")}>Always</button>
                  <button type="button" className="link" onClick={() => answerSteer(item, "cancel")}>Cancel</button>
                </div>
              </div>}
            </div>
          </div>;
        })}
      </div>}
      {!profileMode && (unread > 0 || cardsAway.length > 0) && <div className="transcript-pills">
        {cardsAway.length > 0 && <button type="button" className="transcript-pill" onClick={() => showCard(cardsAway[0].request)}>
          <span className="pill-dot" aria-hidden="true" />
          {waitingLine(owners(cardsAway).map((id) => names.get(id) ?? id))} · Show
        </button>}
        {unread > 0 && <button type="button" className="transcript-pill" onClick={jumpToLatest}>{newPill(unread)}</button>}
      </div>}
      {!profileMode && panel && narrow && !panel.full && <button type="button" className="artifacts-backdrop" aria-label="Close artifacts" onClick={() => setPanel(null)} />}
      {!profileMode && panel && (
        <ArtifactsPanel
          file={artifacts}
          view={panel}
          onView={setPanel}
          onClose={() => setPanel(null)}
          overlay={narrow}
          nameOf={(id) => names.get(id) ?? id}
          colorOf={color}
          onOpenLink={openTarget}
          backend={backend}
          problem={artifactProblem}
        />
      )}
      {!profileMode && !panel && modDock.length > 0 && <ModDock panes={modDock} overlay={narrow} />}
      </div>

      {!profileMode && <div className={tldr ? "composer tldr" : "composer"} ref={composer}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); attachFiles(e.dataTransfer.files); } }}>
        <input ref={filePicker} type="file" accept="image/*,.pdf,.txt,.md,.csv,.json,.log" multiple hidden
          onChange={(e) => { if (e.target.files) attachFiles(e.target.files); e.target.value = ""; }} />
        <div className="composer-input">
        {reply && <div className="quote-preview">
          <div className="quote-preview-copy"><span className="speaker">{reply.id ? `Quoting ${reply.name}` : "Quoting your message"}</span><blockquote>{reply.text}</blockquote></div>
          <span className="pane-menu-wrap hand-off">
            <button ref={handOffButton} type="button" className="ghost small" aria-haspopup="menu" aria-expanded={handOffOpen} onClick={() => setHandOffOpen((open) => !open)}>
              {handOffLabel(quoteTo, (id) => names.get(id) ?? id)} ▾
            </button>
            {handOffOpen && <span className="pane-menu hand-off-menu" role="menu">
              {handOffChoices(quoteTo, participants.map((p) => ({ id: p.id, name: p.display_name }))).map((choice) => (
                <button role="menuitem" key={choice.to} onClick={() => { setReply((quote) => (quote ? { ...quote, to: choice.to } : quote)); setHandOffOpen(false); input.current?.focus(); }}>{choice.label}</button>
              ))}
            </span>}
          </span>
          <button className="quote-cancel" aria-label="Cancel quote" onClick={() => { setReply(null); input.current?.focus(); }}>×</button>
        </div>}
        {attached.length > 0 && <div className="attachments" aria-label="Attachments">
          {attached.map((a) => <div className="attachment" key={a.id} title={a.path ?? `${a.name} (saving…)`} aria-busy={!a.path}>
            {a.preview ? <img src={a.preview} alt={a.name} /> : <span className="attachment-name">{a.name}</span>}
            <button className="icon small" aria-label={`Remove ${a.name}`} onClick={() => unattach(a.id)}>×</button>
          </div>)}
        </div>}
        {recipient && lineFits && <div className="recipient-line">
          To {recipient.to} · <ReplyPolicyPicker value={options.policy} label={recipient.reason} disabled={!ready || busy} onChange={policy => changeOptions({ ...options, policy })} />
        </div>}
        <div className="composer-field" ref={field}>
          <ComposerMenu ref={composerMenu} participants={participants} mods={modHost.allCommands()} servers={serverTargets.flatMap(agent => (serverLists[agent] ?? []).map(entry => ({agent, ...entry})))} serverStatus={serverTargets.map(id => serverErrors[id] ?? (serverLists[id] ? "" : `Loading ${names.get(id) ?? id}’s servers, apps and plugins…`)).filter(Boolean).join(" · ")} trigger={findTrigger(text, caret)} choose={(item, trigger) => {
            if (item.kind === "attach") return filePicker.current?.click();
            if (item.kind === "attach-folder") return void backend.pickFolder().then((path) => path && track(`${path.split("/").pop() || path}/`, undefined, () => backend.copyAttachment(pane.id, path)));
            if (item.kind === "command" && item.command) {
              const draft = text;
              runCommand(item.command);
              setText(trigger ? text.slice(trigger.end) : draft);

            } else {
              const next = insertAt(text, trigger, caret, `${item.label} `);
              setText(next.text); setCaret(next.caret);
              requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
            }
            input.current?.focus();
          }} />
        <textarea
          ref={input}
          aria-label="Message the room"
          aria-invalid={unknownServers.length > 0}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (!files.length) return;
            e.preventDefault();
            attachFiles(files);
          }}
          value={text}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
          onSelect={e => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (composerMenu.current?.key(e)) return;
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "t") { e.preventDefault(); toggleTldr(); return; }
            // Esc stops every bot and keeps your draft, like Claude Code and Codex.
            if (e.key === "Escape" && busy) { e.preventDefault(); void turnQueue.halt(); return; }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e.metaKey || e.ctrlKey);
            }
          }}
          rows={1}
          placeholder={tldr ? "TL;DR mode: short answers" : copy.placeholder}
          disabled={!ready || participants.length === 0}
        />
        <button type="button" className="tldr-pill" aria-pressed={tldr} aria-label="TL;DR mode" title={`TL;DR mode ${tldr ? "on" : "off"}: take a chill pill (⌘⇧T)`}
          // Keep focus: collapsing the hint on pointer-down moves the pill before the click lands.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => { toggleTldr(); input.current?.focus(); }}><span aria-hidden>TL;</span><span aria-hidden>DR</span></button>
        </div>
        {unknownServers.length > 0 && <div className="server-error">{unknownServers.map(name => <u key={name}>!{name} </u>)} — unknown server, app or plugin</div>}
        {!busy && <div className="composer-hint"><span>{copy.hint}</span></div>}
        </div>
        <div className="composer-actions">
          {busy
            ? <button type="button" className="round-send stop" aria-label="Stop all" title="Stop every bot (Esc)" onClick={() => { if (Date.now() - flippedAt.current > 600) void turnQueue.halt(); }}><StopSquare size={12} /></button>
            : <button type="button" className="round-send" aria-label="Send" title="Send (↵)" onClick={() => { if (Date.now() - flippedAt.current > 600) void send(); }} disabled={!ready || (!text.trim() && !sendable.length) || saving || participants.length === 0}><SendArrow /></button>}
          <span className="send-key" aria-hidden="true">{copy.keys}</span>
        </div>
      </div>}
    </div>
  );
}

function StopSquare({ size = 10 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" /></svg>;
}

function SendArrow() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>;
}

function SteerArrow() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}

function TrashIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /></svg>;
}
