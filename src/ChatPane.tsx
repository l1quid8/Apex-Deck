import type { AllowedRule, ThreadStatus, ToolServer } from "./types";
import { parseServerRequests, resolveServerRequests } from "./serverRequests";
import { composerCopy, joinNames, replyingVerb, threadStatusOf } from "./composerStatus";
import { slug } from "./slug";
import { nameForModel, uniqueName } from "./quickAdd";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ComposerMenu, type ComposerMenuHandle } from "./ComposerTools";
import { findTrigger, insertAt } from "./composerMenu";
import { createPortal } from "react-dom";
import { ThreadDetails, type DetailsHost } from "./ThreadDetails";
import type { Backend } from "./backend";
import { providerEnabled, providerForConfig } from "./providers";
import { registerRoom } from "./hub";
import { AGENT_EFFORTS, AGENT_MODELS, API_EFFORTS, effortLabel, effortsFor, findModel, modelGroups } from "./models";
import { Picker, type PickerGroup } from "./Picker";
import { DeckIcon } from "./DeckIcon";
import { Avatar, type Refills } from "./Avatar";
import { contextLevel, contextLine, isLow, percent, planLevel, planLine, type Levels } from "./battery";
import { usePlans } from "./plans";
import { AGENT_COLORS, createAppearance, legacyAppearance, type AgentAppearance } from "./identicon";
import { afterRound, type Attention, type Signal } from "./attention";
import { ApprovalCard, type MadeChange } from "./ApprovalCard";
import { approvalSignal, approvalSnapshot, cardsByBot, deadlineNote, forgetRoom, openCards, subscribeApprovals } from "./approvals";
import { describeRule } from "./allowedRules";
import { exportFileName, exportJson, exportMarkdown, type ThreadExport } from "./exportThread";
import { DiffPanel } from "./DiffPanel";
import { RichText } from "./RichText";
import { Markdown } from "./Markdown";
import { ParticipantQueues, type ParticipantMessage, type TurnKind } from "./turnQueue";
import { replyText, type ReplyQuote } from "./reply";
import { attachmentName, withAttachments, type Attachment } from "./attachments";
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
  /** Agents only: bumped to open the new agent form. */
  addRequest?: number;
  onActivity: (paneId: string) => void;
  /** Raise or clear (with `null`) this chat's request for attention. */
  onSignal?: (paneId: string, kind: Attention | null, note?: string) => void;
  /** Raise (with the flag) or clear (with `null`) this chat's blocking flag for its open approval cards. */
  onApprovals?: (paneId: string, signal: Signal | null) => void;
  profiles: ParticipantConfig[];
  onProfilesChange: (profiles: ParticipantConfig[]) => void;
  profileMode?: boolean;
  onFork?: (title: string, upto: number | null) => Promise<string>;
  disabledProviders: string[];
  details?: DetailsHost;
}

type Notice = { key: number; text: string; tone: "info" | "error" };
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

type PresetKey = "claude_code" | "codex" | "gemini" | "ollama" | "api" | "command" | "scripted";

interface Preset {
  key: PresetKey;
  label: string;
  /** Every effort level the backend understands. Empty means it has no such setting. */
  efforts: string[];
  /** Set for presets that run a known coding agent. Its models are listed in models.ts. */
  agent?: { tool: AgentTool; detectKey: string; modelNote: string; enforcesAccess: boolean };
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
    agent: { tool: "claude_code", detectKey: "claude", modelNote: "A short name such as opus follows the newest version. Pick a full name to stay on one version.", enforcesAccess: true },
  },
  {
    key: "codex",
    label: "Codex",
    efforts: AGENT_EFFORTS.codex,
    agent: { tool: "codex", detectKey: "codex", modelNote: "Your account may not offer every model; Codex says so in the chat if not.", enforcesAccess: true },
  },
  {
    key: "gemini",
    label: "Gemini CLI",
    efforts: AGENT_EFFORTS.gemini,
    agent: { tool: "gemini", detectKey: "gemini", modelNote: "Names are from Google's model list. Gemini CLI says so in the chat if your account cannot use one.", enforcesAccess: false },
  },
  { key: "ollama", label: "Ollama (local models)", efforts: API_EFFORTS, api: { baseUrl: "http://localhost:11434/v1", autoLoad: true } },
  { key: "api", label: "Other API (OpenAI-compatible)", efforts: API_EFFORTS, api: { baseUrl: "", autoLoad: false } },
  { key: "command", label: "Custom command", efforts: [] },
  { key: "scripted", label: "Scripted (no model, for testing)", efforts: [] },
];

const AGENT_LABEL: Record<AgentTool, string> = { claude_code: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };

const MODELS_KEY = "apex-deck.models.v1";

/** Model names typed before, per preset, so they are offered again. */
function rememberedModels(): Partial<Record<PresetKey, string[]>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function rememberModel(preset: PresetKey, model: string) {
  if (!model) return;
  try {
    const all = rememberedModels();
    const list = all[preset] ?? [];
    if (!list.includes(model)) {
      all[preset] = [model, ...list].slice(0, 12);
      localStorage.setItem(MODELS_KEY, JSON.stringify(all));
    }
  } catch {
    // Storage can be unavailable; the name is then simply not remembered.
  }
}

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

function emptyDraft(preset: PresetKey): Draft {
  const found = PRESETS.find((p) => p.key === preset);
  return { name: "", preset, model: "", effort: "", baseUrl: found?.api?.baseUrl ?? "", keyEnv: "", command: "", persona: "", access: "read" };
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

function phaseLabel(phase: TurnProgress["phase"] | undefined): string {
  if (phase === "tool") return "Working";
  if (phase === "writing") return "Writing";
  return "Thinking";
}

/** Time since a turn began: 8s, 1m 05s. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Running token totals for one participant. */
interface TokenUse {
  input: number;
  output: number;
  turns: number;
}

function tokenDetail(use: TokenUse): string {
  const turns = use.turns === 1 ? "1 turn" : `${use.turns} turns`;
  return `${use.input.toLocaleString()} in, ${use.output.toLocaleString()} out over ${turns} since the app opened. Input includes the conversation and files the tool re-read from its cache.`;
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
    backend: { kind: "scripted", lines: ["I'm Ben. I answer when you @ben me. Try @all to hear from both of us.", "Add a real model with + Add model when you're ready.", "[pass]"] } },
];

/** Starter roles offered in an empty Agents section. */
const STARTERS = [
  { name: "Reviewer", note: "Reads the change and flags bugs.", persona: "You are the reviewer. Read the change, look for bugs and risky edge cases, and be brief.", access: "read" as Access },
  { name: "Planner", note: "Breaks the work into steps.", persona: "You are the planner. Break the request into small, ordered steps and name the files each one touches.", access: "read" as Access },
  { name: "Implementer", note: "Makes the edits.", persona: "You are the implementer. Make the change in small steps and say what you changed.", access: "ask" as Access },
];

export function ChatPane({ pane, cwd, workspaceName = "", onStatus, addRequest, agents, backend, focused, onActivity, onSignal, onApprovals, onFork, profiles, onProfilesChange, disabledProviders, profileMode = false, details }: Props) {
  const [participants, setParticipants] = useState<ParticipantConfig[]>(profileMode ? profiles : []);
  const [options, setOptions] = useState<RoomOptions>({ policy: "mention", max_bot_hops: 3 });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [allowed, setAllowed] = useState<AllowedRule[]>([]);
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
  /** Tokens each participant has used in this chat since the app opened. */
  const [used, setUsed] = useState<Record<string, TokenUse>>({});
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
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const composerMenu = useRef<ComposerMenuHandle>(null);
  const [queued, setQueued] = useState<ParticipantMessage[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [reply, setReply] = useState<ReplyQuote | null>(null);
  const [adding, setAdding] = useState(false);
  /** Where the quick add menu is open: under the empty thread's button, or in the sidebar. */
  const [quickAdd, setQuickAdd] = useState<"empty" | "details" | null>(null);
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
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(firstPreset));
  const [apiModels, setApiModels] = useState<string[]>([]);
  const [modelNote, setModelNote] = useState("");
  /** What each coding agent reports it can use, asked once per tool. */
  const [reported, setReported] = useState<Partial<Record<AgentTool, ModelChoice[]>>>({});
  const [formError, setFormError] = useState("");
  /** The id of the participant being edited, or null when adding a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  const [ready, setReady] = useState(profileMode);

  useEffect(() => { if (profileMode) setParticipants(profiles); }, [profiles, profileMode]);

  const noticeKey = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const saving = attached.some((a) => !a.path && !a.error);
  const sendable = attached.filter((a) => a.path);
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const signal = useRef(onSignal);
  signal.current = onSignal;
  const approvals = useRef(onApprovals);
  approvals.current = onApprovals;
  // What happened in the round of replies now running, to decide when it
  // ends whether the chat wants attention. See afterRound in attention.ts.
  const round = useRef<{ failed: string[]; lastReply: string | null; stopped: boolean }>({ failed: [], lastReply: null, stopped: false });
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
  // Who is replying right now, for the line above the composer.
  const replying = participants.filter(p => working[p.id]);
  const replyingSince = replying.length ? Math.min(...replying.map(p => working[p.id].startedAt)) : 0;
  const copy = composerCopy(busy, participants.length === 0);

  const forgetContext = () => {
    setContextFill({});
    lowContext.current.clear();
    pendingLow.current.clear();
  };

  const notify = (message: string, tone: Notice["tone"] = "info") =>
    setEntries((list) => [...list, { kind: "notice", notice: { key: noticeKey.current++, text: message, tone } }]);

  useEffect(() => {
    if (profileMode) return;
    let alive = true;
    const nameOf = (id: string) => namesRef.current.get(id) ?? id;
    /** Tell the app what this thread's open cards want. The store has seen the event already (hub.ts). */
    const reportApprovals = () => approvals.current?.(pane.id, approvalSignal(openCards(pane.id), namesRef.current, Date.now()));
    const unregister = registerRoom(pane.id, (event: RoomEvent) => {
      activity.current(pane.id);
      if (event.type === "tool_servers") { setServerErrors(errors => { const next = {...errors}; delete next[event.id]; return next; }); setServerLists(lists => ({...lists, [event.id]: event.servers})); return; }
      switch (event.type) {
        case "message_added":
          if (event.message.speaker.kind === "bot") {
            const id = event.message.speaker.id;
            setDrafts(({ [id]: _done, ...rest }) => rest);
            setWorking(({ [id]: _done, ...rest }) => rest);
            round.current.lastReply = event.message.text;
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
          setDrafts(({ [event.id]: _done, ...rest }) => rest);
          setWorking(({ [event.id]: _done, ...rest }) => rest);
          reportApprovals();
          turnQueue.idle(event.id);
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
          notify(`${nameOf(event.id)} could not reply: ${event.error}`, "error");
          break;
        case "hop_limit_reached":
          notify(`Stopped after ${event.limit} rounds of models answering each other.`);
          break;
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
      .roomCreate(pane.id, pane.sample ? SAMPLE_BOTS : [], { policy: "mention", max_bot_hops: 3 }, cwd)
      .then((saved) => {
        if (!alive) return;
        setChanges((saved.changes ?? []).map((c) => ({ seq: c.seq, by: c.by, change: { path: c.path, added: c.added, removed: c.removed, diff: "" } })));
        setParticipants(saved.participants);
        setOptions(saved.options);
        setPins(saved.pins ?? []);
        setAllowed(saved.allowed ?? []);
        const restored: Entry[] = saved.transcript.map((message) => ({ kind: "message", message }));
        // A saved summary does not say who wrote it.
        if (saved.compaction) restored.splice(Math.min(saved.compaction.upto, restored.length), 0, { kind: "summary", summary: { by: null, ...saved.compaction } });
        setEntries(restored);
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

  /** Open a file, folder or web address a message links to. */
  const openTarget = (target: string, reveal = false) => {
    backend.openTarget(target, cwd || null, reveal).catch((error) => notify(`Could not open ${target}: ${String(error)}`, "error"));
  };

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, drafts, asks]);

  useEffect(() => {
    if (focused && !adding && ready) input.current?.focus();
  }, [focused, adding, ready]);

  const closeForm = (preset: PresetKey) => {
    setDraft(emptyDraft(preset));
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
        setUsed({});
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

  const dispatch = useRef<(message: string, to: string[], kind: TurnKind) => Promise<void>>(async () => {});
  dispatch.current = async (message, to, kind) => {
    if (kind === "compact") {
      try { await backend.roomCompact(pane.id); }
      finally { to.forEach(id => turnQueue.idle(id)); }
    } else await backend.roomPostTo(pane.id, message, to);
  };
  const [turnQueue] = useState(() => new ParticipantQueues(
    message => backend.roomTargets(pane.id, message),
    (message, to, kind) => dispatch.current(message, to, kind),
    id => backend.roomStop(pane.id, id),
    items => { setQueued(items); setBusy(turnQueue.active); setQueuePaused(turnQueue.paused.size > 0); },
    error => { notify(`Could not send: ${String(error)}. Affected queues are paused.`, "error"); },
  ));
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (ready && busy) void backend.roomTargets(pane.id, text).then(ids => { if (alive) setRecipients(ids); }).catch(() => {});
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [text, ready, busy, pane.id]);
  const forkAt = (title: string, upto: number | null) => {
    if (!onFork) return notify("Forking is available in workspace threads.", "error");
    return onFork(title, upto)
      .then((name) => notify(`Forked into “${name}”. Both threads work in the same folder, so file edits in one show up in the other.`))
      .catch((error) => notify(`Could not fork: ${String(error)}`, "error"));
  };
  const forkButton = (seq: number) => onFork && <button className="quote-reply-icon fork-message-icon" aria-label="Fork from here" title="Fork from here" onClick={() => forkAt(`${pane.title} (fork)`, seq + 1)}>
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v5a3 3 0 0 0 3 3 3 3 0 0 1 3 3v1M11 2v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="5" cy="2.5" r="1.2"/><circle cx="11" cy="2.5" r="1.2"/></svg>
  </button>;
  /** Commands run locally and never reach the models. */
  const runCommand = (command: Command) => {
    switch (command.name) {
      case "clear":
        if (busy || turnQueue.active) return notify("Wait for the models to finish before clearing the chat.");
        return clearChat();
      case "compact":
        return compactChat();
      case "pin":
        if (unpinPending.current) return notify("Wait for the pending pin change to finish.");
        if (!command.fact) return notify("Type the fact after /pin, for example: /pin we're on Tauri 2, don't suggest Electron");
        unpinPending.current = true; setUnpinning(true);
        setText("");
        return void backend.roomPin(pane.id, command.fact)
          .then((next) => { setPins(next); notify(busy ? "Pinned. It applies from the next turn." : "Pinned for every model in this chat."); })
          .catch((error) => { setText(`/pin ${command.fact}`); notify(`Could not pin: ${String(error)}`, "error"); })
          .finally(() => { unpinPending.current = false; setUnpinning(false); });
      case "fork":
        setText(""); return void forkAt(command.title || `${pane.title} (fork)`, null);
      case "export": {
        setText("");
        const at = new Date();
        const thread: ThreadExport = { title: pane.title, participants, transcript: messagesOf(entries), pins, compaction: compactionOf(entries) };
        const contents = command.format === "json" ? exportJson(thread, at) : exportMarkdown(thread, at);
        return void backend.exportThread(exportFileName(pane.title, command.format, at), contents)
          .then((path) => { if (path) { notify(`Exported to ${path}`); openTarget(path, true); } })
          .catch((error) => notify(`Could not export: ${String(error)}`, "error"));
      }

      case "diff":
        setText(""); details?.show("changes"); loadDiff(); return;
      case "unknown":
        return notify(`${command.typed} isn't a command. Start with // to send it as a message.`, "error");

    }
  };

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
      const name = path.split("/").pop() || path;
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
  useEffect(() => {
    if (!ready || !participants.length) return;
    let live = true;
    backend.roomTargets(pane.id, text).then(ids => { if (live) setServerTargets(ids); }).catch(() => {});
    return () => { live = false; };
  }, [backend, pane.id, text, ready, participants]);
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
    const targetIds = await backend.roomTargets(pane.id, text).catch(() => [] as string[]);
    const invalid = targetIds.length && targetIds.every(id => serverLists[id] !== undefined)
      ? resolveServerRequests(parseServerRequests(text).map(s => s.name), targetIds.flatMap(id => serverLists[id])).unknown : [];
    if (invalid.length) { notify(`No server, app or plugin called "${invalid[0]}" for ${targetIds.map(id => names.get(id) ?? id).join(", ")}`, "error"); return; }
    const body = text.trim();
    if ((!body && !sendable.length) || !ready || saving) return;
    const parsed = body ? parseComposer(body) : { text: "" };
    if ("command" in parsed) return runCommand(parsed.command);
    if (participants.length === 0) return;
    const message = withAttachments(parsed.text && replyText(postable(parsed.text), reply), sendable.map((a) => a.path!));
    setText(""); setReply(null);
    attached.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
    setAttached([]);
    if (steer) {
      void backend.roomTargets(pane.id, message).then(async ids => {
        const target = ids.find(id => turnQueue.state[id] === "working");
        if (target) await turnQueue.steer(target, message);
        else await turnQueue.send(message);
      }).catch(error => notify(String(error), "error"));
    } else void turnQueue.send(message).catch(error => notify(String(error), "error"));
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
    setDraft((d) => ({ ...emptyDraft(key), appearance: d.appearance, name: d.name, persona: d.persona, access: d.access === "ask" && !next.agent?.enforcesAccess ? "read" : d.access }));
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

  // The pane head's words, and who is replying or stopped on a card, for App.
  const status = threadStatusOf(participants, Object.keys(working), Object.keys(asks).filter((id) => asks[id].length > 0));
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
    const reports = p.backend.kind === "agent" && p.backend.tool !== "gemini";
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
        <p className="usage-note">{used[p.id] ? tokenDetail(used[p.id]) : "No tokens used in this chat yet."}</p>
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
    if (!providerEnabled(draft.preset, disabledProviders)) setDraft(emptyDraft(firstPreset));
    setEditing(null);
    setAdding(true);
  }
  /** Save a starter role as an agent, on the first coding agent that is installed. */
  const addStarter = (starter: typeof STARTERS[number]) => {
    const start = PRESETS.find((p) => p.key === firstPreset)!;
    const name = uniqueName(starter.name, participants.map((p) => p.id), slug);
    const built = draftToConfig({ ...emptyDraft(firstPreset), name, persona: starter.persona, access: starter.access === "ask" && !start.agent?.enforcesAccess ? "read" : starter.access });
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
                {preset.agent?.enforcesAccess && <option value="ask">Ask first (you approve each edit and command)</option>}
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
  const openQuickAdd = (where: "empty" | "details") => {
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
            {preset.agent?.enforcesAccess && <option value="ask">Ask first</option>}
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
  const quickAddButton = (where: "empty" | "details", primary: boolean) => (
    <span className={`quick-add-wrap ${where}`}>
      <button className={primary ? "primary" : "ghost"} disabled={!ready || availablePresets.length === 0} aria-haspopup="dialog" aria-expanded={quickAdd === where} onClick={() => openQuickAdd(where)}>+ Add model</button>
      {quickAdd === where && quickAddMenu}
    </span>
  );
  const savedPicker = (availableProfiles.length > 0 && <select aria-label="Add a saved agent" value="" disabled={!ready || busy} onChange={async (e) => {
          const config = availableProfiles.find((p) => p.id === e.target.value);
          if (config) await addSaved(config);
        }}>
          <option value="">Add a saved agent…</option>
          {availableProfiles.map((p) => <option key={p.id} value={p.id} disabled={participants.some((own) => own.id === p.id)}>{p.display_name}</option>)}
        </select>);
  const roomControls = (<div className="chat-options">
          <label>
            Who answers
            <select disabled={!ready || busy} value={options.policy} onChange={(e) => changeOptions({ ...options, policy: e.target.value as TurnPolicy })}>
              <option value="mention">Only who I @mention</option>
              <option value="everyone">Everyone at once</option>
              <option value="round_robin">Everyone in turn</option>
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
        </div>);
  const pinControls = (pins.length > 0 ? <details className="pins" aria-label="Pinned for every model">
        <summary className="pins-label">Pinned <span>({pins.length})</span></summary>
        <div className="pins-list">
        {pins.map((pin, index) => <div className="pin" key={pin}>
          <span className="pin-text" title={pin}>{pin}</span>
          <button className="icon small" aria-label={`Unpin ${pin}`} disabled={unpinning} onClick={() => removePin(index)}>×</button>
        </div>)}
        </div>
      </details> : <p className="muted">No pinned facts. Add one with /pin.</p>);
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
  })}{adding && !editing ? addButton : quickAddButton("details", false)}{savedPicker}</>;
  const allowedList = allowed.length === 0
    ? <p className="muted allowed-empty">Nothing yet. Choose Always allow on an approval card and it shows here, so you can take it back.</p>
    : <ul className="allowed-list" aria-label="Always allowed">
      {allowed.map((rule) => <li key={`${rule.by}\u001f${rule.kind}\u001f${rule.what}`}>
        <span className="allowed-copy">
          <strong style={{ color: color(rule.by) }}>{names.get(rule.by) ?? rule.by}</strong>
          <span className={rule.kind === "command" ? "mono" : undefined} title={rule.what}>{describeRule(rule)}</span>
        </span>
        <button className="ghost small" aria-label={`Stop always allowing ${describeRule(rule)} for ${names.get(rule.by) ?? rule.by}`}
          onClick={() => backend.roomForgetAllowed(pane.id, rule).catch((error) => notify(`Could not remove it: ${String(error)}`, "error"))}>Remove</button>
      </li>)}
    </ul>;
  return (
    <div className={`chat ${profileMode ? "" : "thread-chat"}`}>
      {!profileMode && details?.target === pane.id && details.open && details.slot && createPortal(<ThreadDetails host={details} title={pane.title} cwd={cwd} subtitle={[workspaceName, participants.length === 1 ? "1 bot" : `${participants.length} bots`].filter(Boolean).join(" · ")} bots={botControls} form={modelForm} room={roomControls} allowed={allowedList} changes={<DiffPanel diff={diff} loading={diffLoading} order={participants.map(p => p.id)} onRefresh={loadDiff} nameOf={id => names.get(id) ?? id} colorOf={color} onReveal={path => openTarget(path, true)} />} />, details.slot)}
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
              <button className="chip-name" onClick={() => mention(p.id)} title={`Mention @${p.id}`}>
                <Avatar seed={appearance(p.id).seed} color={color(p.id)} size="sm" working={Boolean(working[p.id]) && !asks[p.id]?.length} levels={levels} refills={refillsFor(p.id)} />
                <span className={`participant-status ${working[p.id]?.phase ?? "idle"}`} aria-label={`${p.display_name}: ${working[p.id]?.phase ?? "idle"}`} />
                {p.display_name}
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
            {card === p.id && usageCard(p)}
            </span>
            );
          })}
          {/* An empty library offers its own button inside the starter card. */}
          {profileMode && (participants.length > 0 || adding) && addButton}
        </div>



        {!profileMode && <div className="thread-counts">{changes.length > 0 && <button className="ghost small" onClick={() => { details?.show("changes"); loadDiff(); }}>Changes · {new Set(changes.map(c => c.change.path)).size}</button>}</div>}
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

      <div className="chat-body">
      {!profileMode && <div className="transcript" ref={scroller}>
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
          </div>
        )}
        {entries.map((entry) =>
          entry.kind === "notice" ? (
            <p key={`n${entry.notice.key}`} className={`notice ${entry.notice.tone}`}>
              {entry.notice.text}
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
              <Markdown text={entry.summary.summary} onOpen={openTarget} />
            </details>
          ) : entry.message.speaker.kind === "human" ? (
            <div key={`m${entry.message.seq}`} className="bubble human">
              <RichText text={entry.message.text} onOpen={openTarget} />
              {forkButton(entry.message.seq)}
            </div>
          ) : (
            <div key={`m${entry.message.seq}`} className="bot-row">
              <Avatar
                seed={appearance(entry.message.speaker.id).seed}
                color={color(entry.message.speaker.id)}
                {...(newestReply.get(entry.message.speaker.id) === entry.message.seq ? { levels: levelsFor(entry.message.speaker.id), refills: refillsFor(entry.message.speaker.id) } : {})}
              />
              <div className="bubble bot completed">
                <span className="speaker" style={{ color: color(entry.message.speaker.id) }}>
                  {names.get(entry.message.speaker.id) ?? entry.message.speaker.id}
                </span>
                <Markdown text={entry.message.text} onOpen={openTarget} />
                <button className="quote-reply-icon" aria-label={`Quote response from ${names.get(entry.message.speaker.id) ?? entry.message.speaker.id}`} onClick={() => {
                  if (entry.message.speaker.kind !== "bot") return;
                  setReply({ id: entry.message.speaker.id, name: names.get(entry.message.speaker.id) ?? entry.message.speaker.id, text: entry.message.text });
                  input.current?.focus();
                }}><DeckIcon name="reply" size={18} /></button>
                {forkButton(entry.message.seq)}
              </div>
            </div>
          ),
        )}
        {Object.entries(drafts).map(([id, partial]) => {
          const turn = working[id];
          const steps = turn?.steps ?? [];
          // Long turns take many steps; the latest few say where it is.
          const shown = steps.slice(-MAX_STEPS_SHOWN);
          const hidden = steps.length - shown.length;
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
                    action={ask.action}
                    deadline={deadlineNote(ask.action.expires_at, now)}
                    onDecide={(approve, always) => {
                      backend.roomDecide(pane.id, ask.request, approve, always).catch((error) => notify(`Could not send your answer: ${String(error)}`, "error"));
                    }}
                  />
                ))}
                <div className={`working-line ${asks[id]?.length ? "asking" : ""}`} role="status">
                  <span className="working-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>{asks[id]?.length ? "Waiting for you" : phaseLabel(turn?.phase)}</span>
                  {turn && <span className="working-time">{elapsed(now - turn.startedAt)}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>}
      </div>

      {!profileMode && <div className="composer" ref={composer}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); attachFiles(e.dataTransfer.files); } }}>
        <input ref={filePicker} type="file" accept="image/*,.pdf,.txt,.md,.csv,.json,.log" multiple hidden
          onChange={(e) => { if (e.target.files) attachFiles(e.target.files); e.target.value = ""; }} />
        <div className="composer-input">
        {busy && replying.length > 0 && <div className="composer-status" role="status">
          <span className="composer-status-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="composer-status-who">
            {replying.map((p, index) => <span key={p.id}>
              {index > 0 && (index === replying.length - 1 ? " and " : ", ")}
              <strong style={{ color: color(p.id) }}>{p.display_name}</strong>
            </span>)} {replyingVerb(replying.length)}
          </span>
          <span className="composer-status-time" aria-label={`for ${elapsed(now - replyingSince)}`}>{elapsed(now - replyingSince)}</span>
          <button className="danger small" aria-label={`Stop ${joinNames(replying.map(p => p.display_name))}`} onClick={() => void turnQueue.halt()}>Stop</button>
        </div>}
        {queued.length > 0 && <details className="queued-messages" aria-label="Queued messages" open>
          <summary>{queuePaused ? "Paused" : "Queued"} ({queued.length}) · {queued[0].to.map(id => names.get(id) ?? id).join(", ")}: “{queued[0].text.slice(0, 65)}”</summary>
          {queued.map(item => <div className="queued-message" key={item.id}>
            <span>{item.to.map(id => names.get(id) ?? id).join(", ")}</span>
            <textarea aria-label={`Queued message ${item.id}`} rows={2} defaultValue={item.text} onBlur={e => {
              if (e.target.value === item.text) return;
              const parsed = parseQueueEdit(e.target.value);
              if ("text" in parsed) turnQueue.edit(item.id, parsed.text);
              else if (parsed.command.name === "compact") turnQueue.edit(item.id, "/compact", "compact");
              else { turnQueue.remove(item.id); setText(e.target.value); runCommand(parsed.command); }
            }} />
            <button className="icon" aria-label="Remove queued message" onClick={() => turnQueue.remove(item.id)}>×</button>
          </div>)}
          {queuePaused && <button className="ghost" onClick={() => { setQueuePaused(false); turnQueue.resume(); }}>Resume queue</button>}
        </details>}
        {busy && recipients.length > 0 && <div className="recipient-hint">To {recipients.map(id => names.get(id) ?? id).join(", ")} · {recipients.some(id => turnQueue.state[id] === "working") ? "queued (busy)" : "starts now"}</div>}
        {reply && <div className="quote-preview">
          <div className="quote-preview-copy"><span className="speaker">{reply.name}</span><blockquote>{reply.text}</blockquote></div>
          <button className="quote-cancel" aria-label="Cancel quote" onClick={() => { setReply(null); input.current?.focus(); }}>×</button>
        </div>}
        {attached.length > 0 && <div className="attachments" aria-label="Attachments">
          {attached.map((a) => <div className="attachment" key={a.id} title={a.path ?? `${a.name} (saving…)`} aria-busy={!a.path}>
            {a.preview ? <img src={a.preview} alt={a.name} /> : <span className="attachment-name">{a.name}</span>}
            <button className="icon small" aria-label={`Remove ${a.name}`} onClick={() => unattach(a.id)}>×</button>
          </div>)}
        </div>}
        <div className="composer-field">
          <ComposerMenu ref={composerMenu} participants={participants} servers={serverTargets.flatMap(agent => (serverLists[agent] ?? []).map(entry => ({agent, ...entry})))} serverStatus={serverTargets.map(id => serverErrors[id] ?? (serverLists[id] ? "" : `Loading ${names.get(id) ?? id}’s servers, apps and plugins…`)).filter(Boolean).join(" · ")} trigger={findTrigger(text, caret)} choose={(item, trigger) => {
            if (item.kind === "attach") return filePicker.current?.click();
            if (item.kind === "command" && item.command) {
              const draft = text;
              runCommand(item.command);
              setText(trigger ? text.slice(trigger.end) : draft);
            } else if (item.kind === "command" && !trigger && text.trim()) {
              runCommand({ name: "pin", fact: text.trim() });
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
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e.metaKey || e.ctrlKey);
            }
          }}
          rows={2}
          placeholder={copy.placeholder}
          disabled={!ready || participants.length === 0}
        />
        </div>
        {unknownServers.length > 0 && <div className="server-error">{unknownServers.map(name => <u key={name}>!{name} </u>)} — unknown server, app or plugin</div>}
        <div className="composer-hint"><span>@ who answers · ! which tools · {copy.hint}</span></div>
        </div>
        <div className="composer-actions">
          {busy && <button className="ghost composer-steer" onClick={() => send(true)} disabled={!ready || !text.trim() || saving} title="Send to the busy model you mentioned now">Steer <kbd>⌘↵</kbd></button>}
          <button className="primary" onClick={() => send()} disabled={!ready || (!text.trim() && !sendable.length) || saving || participants.length === 0}>{busy ? <>Queue <kbd>↵</kbd></> : <><DeckIcon name="send" size={18} /> Send</>}</button>
          {busy && replying.length > 1 && <details className="turn-controls"><summary aria-label="Turn controls">⋯</summary><div className="turn-controls-menu">
            {participants.filter(p => turnQueue.state[p.id] === "working").map(p => <div key={p.id}>
              <button className="ghost small" disabled={!text.trim()} onClick={() => { const message = text; setText(""); void turnQueue.steer(p.id, message); }}>Steer {p.display_name}</button>
              <button className="ghost small" onClick={() => void turnQueue.halt(p.id)}>Stop {p.display_name}</button>
            </div>)}
            <button className="ghost small" onClick={() => void turnQueue.halt()}>Stop all</button>
          </div></details>}
        </div>
      </div>}
    </div>
  );
}
