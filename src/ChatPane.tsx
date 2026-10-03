import { useEffect, useMemo, useRef, useState } from "react";

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
import { afterRound, type Attention } from "./attention";
import { ApprovalCard, ChangesPanel, type MadeChange } from "./Approvals";
import { RichText } from "./RichText";
import { Markdown } from "./Markdown";
import { TurnQueue, type QueuedMessage } from "./turnQueue";
import { replyText, type ReplyQuote } from "./reply";
import { parseComposer, postable, type Command } from "./commands";
import type {
  Access,
  AgentInfo,
  AgentTool,
  Message,
  ModelChoice,
  Pane,
  ParticipantBackend,
  ParticipantConfig,
  ProposedAction,
  RoomEvent,
  RoomOptions,
  TurnPolicy,
} from "./types";

interface Props {
  pane: Pane;
  /** The workspace folder. Command-line participants run here. */
  cwd: string;
  /** Which coding agents are installed, to enable their presets. */
  agents: AgentInfo[];
  backend: Backend;
  focused: boolean;
  onActivity: (paneId: string) => void;
  /** Raise or clear (with `null`) this chat's request for attention. */
  onSignal?: (paneId: string, kind: Attention | null, note?: string) => void;
  profiles: ParticipantConfig[];
  onProfilesChange: (profiles: ParticipantConfig[]) => void;
  profileMode?: boolean;
  disabledProviders: string[];
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


/** The @handle the room will match: lower-case letters, digits, dash, underscore, dot. */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_.]/gu, "")
    .replace(/\.+$/, "");
}

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

export function ChatPane({ pane, cwd, agents, backend, focused, onActivity, onSignal, profiles, onProfilesChange, disabledProviders, profileMode = false }: Props) {
  const [participants, setParticipants] = useState<ParticipantConfig[]>(profileMode ? profiles : []);
  const [options, setOptions] = useState<RoomOptions>({ policy: "mention", max_bot_hops: 3 });
  const [entries, setEntries] = useState<Entry[]>([]);
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
  /** What each bot has proposed and is waiting on a yes or no for. */
  const [asks, setAsks] = useState<Record<string, { request: string; action: ProposedAction }[]>>({});
  /** Files the bots have changed since this chat was opened. */
  const [changes, setChanges] = useState<MadeChange[]>([]);
  const [showChanges, setShowChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [reply, setReply] = useState<ReplyQuote | null>(null);
  const [adding, setAdding] = useState(false);
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
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const signal = useRef(onSignal);
  signal.current = onSignal;
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
    const unregister = registerRoom(pane.id, (event: RoomEvent) => {
      activity.current(pane.id);
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
        case "turn_started":
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
          setAsks((all) => ({ ...all, [event.id]: [...(all[event.id] ?? []), { request: event.request, action: event.action }] }));
          // The turn is stuck until the person answers, wherever they are looking.
          signal.current?.(pane.id, "needs_input", `${nameOf(event.id)} wants approval: ${event.action.title}`);
          break;
        case "approval_resolved":
          setAsks((all) => {
            const left = (all[event.id] ?? []).filter((ask) => ask.request !== event.request);
            const { [event.id]: _settled, ...others } = all;
            const next = left.length > 0 ? { ...others, [event.id]: left } : others;
            if (Object.keys(next).length === 0) signal.current?.(pane.id, null);
            return next;
          });
          break;
        case "changed":
          setChanges((list) => [...list, { seq: list.length, by: event.id, change: event.change }]);
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
          // A round the person stopped themselves needs no flag.
          const wants = round.current.stopped ? null : afterRound(round.current.failed, round.current.lastReply);
          if (wants) signal.current?.(pane.id, wants.kind, wants.note);
          round.current = { failed: [], lastReply: null, stopped: false };
          setBusy(false);
          setDrafts({});
          setWorking({});
          setAsks({});
          break;
        }
      }
    });
    backend
      .roomCreate(pane.id, [], { policy: "mention", max_bot_hops: 3 }, cwd)
      .then((saved) => {
        if (!alive) return;
        setParticipants(saved.participants);
        setOptions(saved.options);
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
    turnQueue.send("/compact");
  };

  const dispatch = useRef<(message: string) => Promise<void>>(async () => {});
  dispatch.current = async (message) => {
    setBusy(true);
    try {
      if (message === "/compact") await backend.roomCompact(pane.id);
      else if (message === "/clear") {
        await backend.roomClear(pane.id); setEntries([]); setUsed({}); forgetContext();
      }
      else await backend.roomPost(pane.id, postable(message));
    } catch (error) {
      // Compaction failures return through the command without a Failed
      // room event. Remove their transient draft and activity as well.
      setDrafts({}); setWorking({}); setAsks({});
      throw error;
    } finally { setBusy(false); }
  };
  const [turnQueue] = useState(() => new TurnQueue(
    (message) => dispatch.current(message),
    () => backend.roomStop(pane.id),
    setQueued,
    (error) => { notify(`Could not send: ${String(error)}. Queued messages are paused.`, "error"); setQueuePaused(true); },
  ));
  /** Commands run locally and never reach the models. */
  const runCommand = (command: Command) => {
    switch (command.name) {
      case "clear":
        if (busy || turnQueue.active) return notify("Wait for the models to finish before clearing the chat.");
        return clearChat();
      case "compact":
        return compactChat();
      case "unknown":
        return notify(`${command.typed} isn't a command. Start with // to send it as a message.`, "error");
      default:
        // Added by later tasks.
        return notify(`${command.name} isn't available yet.`, "error");
    }
  };

  const send = (steer = false) => {
    const body = text.trim();
    if (!body || !ready || participants.length === 0) return;
    const parsed = parseComposer(body);
    if ("command" in parsed) return runCommand(parsed.command);
    const message = replyText(body, reply);
    setText(""); setReply(null);
    if (steer) { setQueuePaused(false); void turnQueue.steer(message); }
    else turnQueue.send(message);
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

  return (
    <div className="chat">
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
                {p.display_name}
                <span className="chip-meta">{describe(p)}</span>
                {(levels.context !== null || levels.plan !== null) && (
                  <span className="chip-meta chip-levels">
                    {levels.context !== null && <span className={isLow(levels.context) ? "usage-low" : undefined} title="Context left">{percent(levels.context)}%</span>}
                    {levels.context !== null && levels.plan !== null && <span className="chip-sep" aria-hidden="true">|</span>}
                    {levels.plan !== null && <span className={isLow(levels.plan) ? "usage-low" : undefined} title="Plan left">{percent(levels.plan)}%</span>}
                  </span>
                )}
              </button>
              <button className="chip-edit" onClick={() => startEditing(p)} aria-label={`Change settings for ${p.display_name}`} title="Change model, effort, access or persona" disabled={busy}>
                ✎
              </button>
              <button className="chip-edit" onClick={() => onProfilesChange([...profiles.filter((profile) => profile.id !== p.id), p])} aria-label={`Save ${p.display_name} to Agents`} title="Save to Agents" disabled={busy}>＋</button>
              <button className="chip-x" onClick={() => removeParticipant(p.id)} aria-label={`Remove ${p.display_name}`} disabled={busy}>
                ×
              </button>
            </span>
            {card === p.id && usageCard(p)}
            </span>
            );
          })}
          <button
            className="ghost"
            onClick={() => {
              if (adding) return closeForm(draft.preset);
              if (preset.api?.autoLoad && apiModels.length === 0) loadModels(draft.baseUrl, draft.keyEnv);
              if (!providerEnabled(draft.preset, disabledProviders)) setDraft(emptyDraft(firstPreset));
              setAdding(true);
            }}
            disabled={!ready || availablePresets.length === 0}
          >
            {adding ? "Cancel" : profileMode ? "+ New agent" : "+ Add model"}
          </button>
        </div>
        {!profileMode && availableProfiles.length > 0 && <select aria-label="Add a saved agent" value="" disabled={!ready || busy} onChange={async (e) => {
          const config = availableProfiles.find((p) => p.id === e.target.value);
          if (!config) return;
          try {
            await backend.roomAddParticipant(pane.id, config);
            setParticipants((list) => [...list, config]);
          } catch (error) { notify(`Could not add the agent: ${String(error)}`, "error"); }
        }}>
          <option value="">Add a saved agent…</option>
          {availableProfiles.map((p) => <option key={p.id} value={p.id} disabled={participants.some((own) => own.id === p.id)}>{p.display_name}</option>)}
        </select>}
        {!profileMode && (
          <button className={`ghost changes-toggle ${showChanges ? "on" : ""}`} onClick={() => setShowChanges((open) => !open)} aria-pressed={showChanges} title="Files the bots have changed in this chat">
            Changes{changes.length > 0 ? ` · ${new Set(changes.map((c) => c.change.path)).size}` : ""}
          </button>
        )}
        {!profileMode && <div className="chat-options">
          <label>
            Who answers
            <select disabled={!ready || busy} value={options.policy} onChange={(e) => changeOptions({ ...options, policy: e.target.value as TurnPolicy })}>
              <option value="mention">Only who I @mention</option>
              <option value="everyone">Everyone at once</option>
              <option value="round_robin">Everyone in turn</option>
            </select>
          </label>
          <label title="How many rounds of models answering each other are allowed after one of your messages">
            Model-to-model rounds
            <input
              type="number"
              min={0}
              max={10}
              value={options.max_bot_hops}
              disabled={!ready || busy}
              onChange={(e) => changeOptions({ ...options, max_bot_hops: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
            />
          </label>
        </div>}
      </div>

      {adding && (
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
      )}

      {profileMode && <div className="agent-library">
        {participants.length === 0 && !adding && <div className="empty"><h3>Create your first agent</h3><p>Save a bot profile here, then add it to a conversation in Threads.</p></div>}
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
                    onDecide={(approve) => {
                      backend.roomDecide(pane.id, ask.request, approve).catch((error) => notify(`Could not send your answer: ${String(error)}`, "error"));
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
      {!profileMode && showChanges && (
        <ChangesPanel changes={changes} nameOf={(id) => names.get(id) ?? id} colorOf={color} onReveal={(path) => openTarget(path, true)} onClose={() => setShowChanges(false)} />
      )}
      </div>

      {!profileMode && <div className="composer">
        <div className="composer-input">
        {queued.length > 0 && <div className="queued-messages" aria-label="Queued messages">
          <span className="muted">{queuePaused ? "Queue paused" : "Queued for the next turn"}</span>
          {queued.map(item => <div className="queued-message" key={item.id}>
            <textarea aria-label={`Queued message ${item.id}`} rows={2} value={item.text} onChange={e => turnQueue.edit(item.id, e.target.value)} />
            <button className="icon" aria-label="Remove queued message" onClick={() => turnQueue.remove(item.id)}>×</button>
          </div>)}
          {queuePaused && <button className="ghost" onClick={() => { setQueuePaused(false); turnQueue.resume(); }}>Resume queue</button>}
        </div>}
        {reply && <div className="quote-preview">
          <div className="quote-preview-copy"><span className="speaker">{reply.name}</span><blockquote>{reply.text}</blockquote></div>
          <button className="quote-cancel" aria-label="Cancel quote" onClick={() => { setReply(null); input.current?.focus(); }}>×</button>
        </div>}
        <textarea
          ref={input}
          aria-label="Message the room"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e.metaKey || e.ctrlKey);
            }
          }}
          rows={2}
          placeholder={participants.length === 0 ? "Add a model to start" : "Message the room. @name picks who answers."}
          disabled={!ready || participants.length === 0}
        />
        <div className="composer-hint"><span>{busy ? "Models are responding…" : "@name to mention · @all for everyone · / for commands: compact, clear, pin, diff, fork, export"}</span><span>{busy ? "Enter to queue · ⌘Enter to steer" : "Enter to send"} · Shift + Enter for a new line</span></div>
        </div>
        {busy ? (
          <div className="composer-actions">
            <button className="primary" onClick={() => send()} disabled={!text.trim()}>Queue</button>
            <button className="ghost" onClick={() => send(true)} disabled={!text.trim()} title="Interrupt the current reply and send now. @name chooses who answers.">Steer</button>
            <button className="danger" onClick={() => { setQueuePaused(true); void turnQueue.halt(); }}>Stop</button>
          </div>
        ) : (
          <button className="primary" onClick={() => send()} disabled={!ready || !text.trim() || participants.length === 0}>
            <DeckIcon name="send" size={18} /> Send
          </button>
        )}
      </div>}
    </div>
  );
}
