import { VoiceCallBar, VoiceCallCapsule, VoiceCallControls, useVoiceHint, useVoiceSlot, type VoiceWho } from './voice/VoiceCallControls';
import { composerButton } from './voice/callView';
import { registerVoiceThread, unregisterVoiceThread, scopeKey } from './voice/coordinator';
import { createThreadVoiceBridge } from './voice/threadBridge';
import { readVoiceSettings, preferenceFor } from './voice/settings';
import type { VoiceSettings, VoiceTurn } from './voice/types';
import { useHostConnection } from "./useHostConnection";
import { ConnectionBanner } from "./ConnectionBanner";
import { hostCanMutate } from "./hostAvailability";
import { createAttachRetry, createRoomRecovery, createRoomTotalsRefresh, isWaitingForOwner, loadRoomAttach, loadRoomState, loadRoomTotals, messageDedup, representedRoomEvent } from "./roomRecovery.ts";
import { aboveAnchor } from "./floating";
import { fitHeight, fitSteps } from "./fit";
import { actionChevron, messageTime } from "./messageActions";
import { responsePin, pinSource, pinText, pinsAfterClear } from "./messagePins";
import { REPLY_POLICIES } from "./ReplyPolicyPicker";
import { BotSettings } from "./BotSettings";
import type { AllowedRule, NextStep, RevertPlan, Speaker, ThreadStatus, ToolServer } from "./types";
import { ArtifactButton, type CodeChoice } from "./ArtifactButton";
import { CodeRunBox, RunButton, outputForMessage } from "./CodeRunBox";
import { commandFrom, isRunnable } from "./codeRun.ts";
import { useCodeRuns } from "./useCodeRuns.ts";
import type { CodeInfo } from "./Markdown";
import { parseBlocks } from "./markdownText";
import { ModDock, useMods } from "./ModView";
import { modHost } from "./mods/host";
import { ArtifactsPanel, DEFAULT_VIEW, type ArtifactsHost, type PanelView } from "./ArtifactsPanel";
import { EMPTY_ARTIFACTS, MAX_SOURCE, addArtifact, addVersion, codeChoices, kindForPath, kindOf, pickVersion, readArtifacts, artifactAutoOpen, upsertFromFile, fromReply, type ArtifactFile } from "./artifacts";
import { parseServerRequests, resolveServerRequests } from "./serverRequests";
import { findServerUrls, isLocalHost, normalizeAddress } from "./previewAddress";
import { failedLine, goBackAlways, goBackAsks, goBackRequest, goBackTitle, initialFiles, saveGoBackAlways, type GoBack, type RevertScope } from "./revertConfirm";
import { saveThreadSteer, steerAnswer, steerAsks, threadSteer, type SteerAnswer, type ThreadSteer } from "./steerConfirm";
import { composerCopy, doingNow, elapsed, headLine, heardFrom, isCommandLine, quietLine, threadStatusOf, type BotProgress } from "./composerStatus";
import { botIdentity, mentionable, mentionFor, slug } from "./slug";
import { copyRenamer, savedToAgents, type CopyOutcome, type CopyRename } from "./agentRenames";
import { nameForModel, uniqueName } from "./quickAdd";
import { addInOrder, batchLabel, checkBatch, lineupText, MAX_NEW_BOTS, splitAdded } from "./batchAdd";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ComposerMenu, type ComposerMenuHandle } from "./ComposerTools";
import { appendToolToken, findTrigger, insertAt } from "./composerMenu";

export const INSERT_COMPOSER_EVENT = "deck:insert-composer";
import { createPortal } from "react-dom";
import { ThreadDetails, type DetailsHost } from "./ThreadDetails";
import type { Backend, KeyState } from "./backend";
import { DEFAULT_LANDING_TEXTURE, keyNameFor, type LandingTextureSettings } from "./settings";
import { LandingTexture } from "./landing/LandingTexture";
import { DEEPSEEK_BASE_URL, providerEnabled, providerForConfig } from "./providers";
import { registerRoom, startHub } from "./hub";
import { rememberModel, rememberedModels } from "./modelMemory";
import { AGENT_EFFORTS, AGENT_MODELS, API_EFFORTS, apiModelGroups, defaultEffortFor, effortLabel, effortsFor, findModel, modelGroups } from "./models";
import type { PickerGroup } from "./Picker";
import { ModelSearchList, ProviderGrid, Segmented, versionBadge } from "./AgentPicker";
import { PersonaDraft } from "./PersonaDraft.tsx";
import { personaWriters } from "./personaDraft";
import { ProviderLogo } from "./providerLogos";
import { DeckIcon } from "./DeckIcon";
import { ReadAloudAction } from "./ReadAloudAction.tsx";
import { Avatar, type Refills } from "./Avatar";
import { contextLevel, countdown, resetDate, contextLine, isLow, liveWindows, percent, planLevel, planLine, spendLine, tokenLine, windowLabel, type Levels } from "./battery";
import { AGENT_LABEL, chipDescription, levelsShown, loadFolded, saveFolded, type ChipParts } from "./botChip";
import { usePlans } from "./plans";
import { AGENT_COLORS, createAppearance, legacyAppearance, type AgentAppearance } from "./identicon";
import { HexColorPicker } from "./HexColorPicker";
import { afterRound, type Attention, type Signal } from "./attention";
import { ApprovalCard, type MadeChange } from "./ApprovalCard";
import { QuestionForm } from "./QuestionForm";
import { answerText, dismissSteps, formKey, formView, forgetQuestions, questionSignal, questionSnapshot, recordQuestion, restoreRoomQuestions, subscribeQuestions, type FormView } from "./questions";
import { recordApproval, approvalSignal, approvalSnapshot, cardsByBot, deadlineNote, forgetRoom, openCards, subscribeApprovals } from "./approvals";
import { REMOVED_NOTE_MS, allowedLine, describeRule, removedLine } from "./allowedRules";
import { exportFileName, exportHtml, exportJson, exportMarkdown, type ThreadExport } from "./exportThread";
import { lastReply } from "./threadCopy.ts";
import { threadStarted } from "./destinations.ts";
import { WorkBar, type WorkContext, type WorkTool } from "./WorkBar";
import { recentFiles } from "./recentFiles.ts";

/** What a ⋯ menu can ask an open or closed thread to do. */
export type ThreadMenuRequest = "fork" | "export" | "share_pdf" | "copy_markdown" | "copy_reply";
import { DiffPanel } from "./DiffPanel";
import { ChangedFilesStrip } from "./ChangedFilesStrip";
import { MAX_STEPS_SHOWN, SavedSteps, WorkSteps } from "./WorkSteps.tsx";
import { applyStepEvent, createStepsIndexLoader, dropStepsFrom, emptyTurnSteps, readReplySteps, savedEntry, type TurnSteps } from "./workSteps.ts";
import { turnFilesFor } from "./turnChanges";
import { nextReviewNumber, reviewDraft, reviewFileNames, reviewPatch, reviewPatches, reviewerRows } from "./review";
import { RichText } from "./RichText";
import { Markdown } from "./Markdown";
import { PreparingCard } from "./interactiveAnswers/AnswerCard.tsx";
import { createAnswerStore, discardAnswerSettingsAfter, flushAnswerStores, retainAnswerStore } from "./interactiveAnswers/answerStore.ts";
import { CARD_LANGUAGE, type AnswerStore } from "./interactiveAnswers/contract.ts";
import { cardVersions, discussDraft, latestGeneratedCardKey } from "./interactiveAnswers/share.ts";
import { ThreadCard } from "./interactiveAnswers/ThreadCard.tsx";
import { ParticipantQueues, queuedSticky, type ParticipantMessage, type TurnKind } from "./turnQueue";
import { handOffChoices, handOffLabel, quoteFor, quoteTarget, replyText, type ReplyQuote } from "./reply";
import { attachedImages, attachedVideos, attachmentName, isImage, replyImages, replyVideos, withAttachments, type Attachment } from "./attachments";
import { mediaKind, priceLabel } from "./media";
import { mediaSendsFor, priceSend, sourceKey } from "./mediaPrice";
import { AttachedImages, AttachedVideos } from "./AttachedImages";
import { loadTldr, saveTldr, splitTldr, wiggle, withTldr } from "./tldr";
import { cardsOutOfView, firstUnseen, isAtBottom, newPill, owners, seenList, seenMark, unseenCount, waitingLine, type CardBox } from "./transcriptPlace";
import { exampleRows, recipientName } from "./recipients";
import { askerOf, hopNotice, letLabel, liveActions, retryFor, stillHere, type NoticeAction } from "./noticeActions";
import { parseComposer, parseQueueEdit, postable, type Command } from "./commands";
import type {
  Access,
  AgentInfo,
  AgentTool,
  Message,
  ApiModel,
  ModelChoice,
  Pane,
  ParticipantBackend,
  ParticipantConfig,
  RoomEvent,
  RoomOptions,
  Speed,
  TurnPolicy,
  ThreadDiff,
  TokenTotals,
} from "./types";
import { SPEED_OPTIONS, supportsSpeed, speedHint } from "./speed";

interface Props {
  voiceSettings?: VoiceSettings;
  onVoiceSettings?: (settings:VoiceSettings)=>void;
  onVoiceFocus?: (roomId:string)=>void;
  pane: Pane;
  /** The workspace folder. Command-line participants run here. */
  cwd: string;
  /** Which coding agents are installed, to enable their presets. */
  agents: AgentInfo[];
  backend: Backend;
  focused: boolean;
  /** Keep background subscriptions active without rendering hidden transcripts. */
  visible?: boolean;
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
  /** Agents renamed in the Agents tab: this chat renames its copy of each, once. */
  copyRenames?: CopyRename[];
  /** What this chat did with a rename, for the note in the app. */
  onCopyRenamed?: (seq: number, outcome: CopyOutcome) => void;
  onFork?: (title: string, upto: number | null, at: number) => Promise<string>;
  /** The Work bar above the message box: project, Files, Tools and where it runs. Threads only. */
  work?: WorkContext;
  /** A started thread was pointed somewhere else: ask New thread or Fork there. With `why`, it couldn't move there, and Fork isn't offered. */
  moveAsk?: { stays: string; project: string; host: string; why?: string; onNew(): void; onFork?(): void; onCancel(): void };
  /** Fork, Export, Share or Copy chosen in a ⋯ menu. Cleared after it is taken. */
  menuRequest?: { id: string; action: ThreadMenuRequest };
  /** Copy › text this thread built (as Markdown, or its last reply), for App to put on the clipboard. */
  onCopy?: (text: string, kind: "markdown" | "reply") => void;
  /** The request was taken, so a remount must not run it again. */
  onMenuDone?: (id: string) => void;
  disabledProviders: string[];
  /** Settings › New threads: what a thread never saved before starts with. */
  newThread?: RoomOptions;
  /** Settings › New threads: the access the add-bot form starts at. */
  newBotAccess?: Access;
  /** Settings › Confirm before steering. A thread can override it. */
  confirmSteer?: boolean;
  /** What the bot chips show (Settings). */
  chipParts?: ChipParts;
  /** The glyph field behind an empty thread (Settings › Appearance). */
  landingTexture?: LandingTextureSettings;
  /** "Always" in the steer prompt turns the setting off everywhere. */
  onConfirmSteer?: (confirm: boolean) => void;
  details?: DetailsHost;
  /** The side panel's Artifacts tab. Without one the panel sits beside the conversation. */
  artifactsHost?: ArtifactsHost;
  /** A detached Artifacts tab observes the owner's saved file instead of collecting a second copy. */
  followArtifacts?: boolean;
  /** Where the Artifacts and Changes counts render, when the host names the slot itself
   *  (a pop-out's top bar) instead of leaving a `.pane-head .pane-counts` to find. */
  countsSlot?: HTMLElement | null;
  /** Attach mode for pop-out windows: subscribe and read, never create or close.
   *  Sends, approvals, answers and live updates stay on; only the Deck window owns the room. */
  attach?: boolean;
  /** Settings → General "Run buttons on code blocks". */
  codeRunButtons?: boolean;
  /** Open a terminal in this thread's project with `command` typed in, not run. */
  onOpenTerminal?: (command: string) => void;
}

/** A line in the transcript from the app. `action` adds Try again or Let them answer. */
type Notice = { key: number; text: string; tone: "info" | "error"; action?: NoticeAction; source?: "room-load" };
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

type PresetKey = "claude_code" | "codex" | "gemini" | "grok" | "muse" | "deepseek" | "ollama" | "api" | "command" | "scripted";

interface Preset {
  key: PresetKey;
  label: string;
  /** Every effort level the backend understands. Empty means it has no such setting. */
  efforts: string[];
  /** Set for presets that run a known coding agent. Its models are listed in models.ts. */
  agent?: { tool: AgentTool; detectKey: string; modelNote: string; enforcesAccess: boolean; asksFirst: boolean };
  /** Set for presets that call an HTTP API. `key` shows the API key box. */
  api?: { baseUrl: string; autoLoad: boolean; key?: boolean };
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
    label: "Antigravity / Gemini",
    efforts: AGENT_EFFORTS.gemini,
    agent: { tool: "gemini", detectKey: "gemini", modelNote: "Names are from Google's model list. Antigravity says so in the chat if your account cannot use one.", enforcesAccess: true, asksFirst: true },
  },
  {
    key: "grok",
    label: "Grok",
    efforts: AGENT_EFFORTS.grok,
    agent: { tool: "grok", detectKey: "grok", modelNote: "The list follows the models Grok offers your account.", enforcesAccess: true, asksFirst: false },
  },
  {
    key: "muse",
    label: "Muse Code (Meta)",
    efforts: AGENT_EFFORTS.muse,
    agent: { tool: "muse", detectKey: "muse", modelNote: "Runs on your Muse Code subscription, never a Meta API key. Each message also sends about 24k tokens of Muse's built-in instructions, so an Everyday plan's 5-hour allowance can run out after a few busy chats. The list follows the models Muse offers your account.", enforcesAccess: true, asksFirst: false },
  },
  { key: "deepseek", label: "DeepSeek", efforts: API_EFFORTS, api: { baseUrl: DEEPSEEK_BASE_URL, autoLoad: true, key: true } },
  { key: "ollama", label: "Ollama (local models)", efforts: API_EFFORTS, api: { baseUrl: "http://localhost:11434/v1", autoLoad: true } },
  { key: "api", label: "Other API (OpenAI-compatible)", efforts: API_EFFORTS, api: { baseUrl: "", autoLoad: false, key: true } },
  { key: "command", label: "Custom command", efforts: [] },
  { key: "scripted", label: "Scripted (no model, for testing)", efforts: [] },
];


interface Draft {
  appearance?: AgentAppearance;
  name: string;
  preset: PresetKey;
  /** Empty means the backend's own default (agent presets only). */
  model: string;
  /** Empty means the backend's own default. */
  effort: string;
  /** Empty follows the tool's own setting (Codex and Claude Code only). */
  speed?: Speed | "";
  baseUrl: string;
  keyEnv: string;
  /** A key typed into the form and not yet saved. Saved to the machine, never into the bot's settings. */
  apiKey?: string;
  command: string;
  persona: string;
  access: Access;
}

/** Whether the preset's form asks for an API key. */
function takesKey(key: PresetKey): boolean {
  return !!PRESETS.find((p) => p.key === key)?.api?.key;
}

/** Whether access is enforced: by an agent's own permission settings, or,
 * for a bot reached through an API, by Apex Deck, which runs its tools. */
function enforcesAccess(preset?: Preset): boolean {
  return !!(preset?.agent?.enforcesAccess || preset?.api);
}

/** Whether the backend can stop and ask before an edit or command. */
function asksFirst(preset?: Preset): boolean {
  return !!(preset?.agent?.asksFirst || preset?.api);
}

/** `access` is the default from settings; a tool that can't ask first gets Read only. */
function emptyDraft(preset: PresetKey, access: Access = "read"): Draft {
  const found = PRESETS.find((p) => p.key === preset);
  const allowed = access === "ask" && !asksFirst(found) ? "read" : access;
  return { name: "", preset, model: "", effort: "", baseUrl: found?.api?.baseUrl ?? "", keyEnv: "", command: "", persona: "", access: allowed };
}

/** The name the draft's key is filed under: the one it names, else one made from the address or the bot's name. */
export function keyNameOf(draft: Pick<Draft, "keyEnv" | "baseUrl" | "name">): string {
  return draft.keyEnv.trim() || keyNameFor(draft.baseUrl) || (slug(draft.name) ? `${slug(draft.name).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY` : "");
}

function keyNote(state: KeyState | null, name: string): string {
  if (state === "saved") return `Saved on this machine as ${name}. Leave blank to keep it.`;
  if (state === "environment") return `Using ${name} from the environment.`;
  return "Kept in this Mac's Keychain (a private file on Linux), never in your chats.";
}

/** How a bot's access reads in menus. */
function accessLabel(access: Access): string {
  switch (access) {
    case "read": return "Read only";
    case "ask": return "Ask first";
    case "edits": return "Can edit files";
    default: return "Full access";
  }
}
/** Put an argument back into command-line form, quoting it if it has spaces. */
function quoteArg(arg: string): string {
  if (arg !== "" && !/[\s"']/.test(arg)) return arg;
  return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
}

/** The form values that would recreate `config`, for editing it. */
export function configToDraft(config: ParticipantConfig): Draft {
  const base = { appearance: config.appearance ?? legacyAppearance(config.id), name: config.display_name, persona: config.persona, access: config.access, effort: config.effort ?? "", speed: config.speed ?? ("" as const), keyEnv: "", command: "", baseUrl: "", model: "" };
  const b = config.backend;
  if (b.kind === "agent") return { ...base, preset: b.tool, model: b.model ?? "" };
  if (b.kind === "open_ai_compatible") {
    const preset = providerForConfig(config) as PresetKey;
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
  return { id, display_name: draft.name.trim(), backend, persona: draft.persona.trim(), access: draft.access, effort, ...(draft.speed && supportsSpeed(backend) ? { speed: draft.speed } : {}), ...(draft.appearance ? { appearance: draft.appearance } : {}) };
}

/** A turn that is still running. */
interface TurnProgress {
  startedAt: number;
  /** What the bot has done so far, oldest first. */
  steps: string[];
  /** The same work as structured steps, when the daemon sends them. */
  work: TurnSteps;
  phase: "thinking" | "tool" | "writing";
}

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

/** The provider whose plan an agent draws on. Each coding agent reports one. */
function planProvider(config: ParticipantConfig | undefined): AgentTool | null {
  const b = config?.backend;
  return b?.kind === "agent" ? b.tool : null;
}

/** One custom provider account: its address and the name its key is saved under. */
function accountOf(config: ParticipantConfig | undefined): { key: string; baseUrl: string; keyEnv: string | null } | null {
  const b = config?.backend;
  if (b?.kind !== "open_ai_compatible") return null;
  const baseUrl = b.base_url.trim().replace(/\/$/, "");
  return { key: `${baseUrl} ${b.api_key_env ?? ""}`, baseUrl, keyEnv: b.api_key_env };
}

function dollars(usd: number): string {
  return usd > 0 && usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`;
}

/** Tokens the latest request filled, against the window. */
interface ContextFill {
  used: number;
  window: number;
}

const ALL_PARTS: ChipParts = { tool: true, effort: true, usage: true };

/** The two scripted bots of the sample thread. */
const SAMPLE_BOTS: ParticipantConfig[] = [
  { id: "ada", display_name: "Ada", persona: "", access: "read", effort: null, appearance: { seed: "sample-ada", color: "#a78bfa" },
    backend: { kind: "scripted", lines: ["Hi, I'm Ada. Mention me with @ada, or everyone with @all.", "Ben sees everything I say, and I see what he says.", "[pass]"] } },
  { id: "ben", display_name: "Ben", persona: "", access: "read", effort: null, appearance: { seed: "sample-ben", color: "#60a5fa" },
    backend: { kind: "scripted", lines: ["I'm Ben. I answer when you @ben me. Try @all to hear from both of us.", "Add a real model with + Add bot when you're ready.", "[pass]"] } },
];



/** Below this width the artifacts panel covers the conversation instead of sitting beside it. */
const NARROW_PX = 760;
/** A message box narrower than this stacks its text above +, TL;DR and Send. */
const STACK_PX = 330;

/** The widest a bot's usage card gets (.usage-card max-width). */
const USAGE_CARD_WIDTH = 340;
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });


/** How much of each bot chip shows, most first. */
const CHIP_STEPS = ["full", "levels", "names", "faces"] as const;
/** How much of the pane's top line shows: then the count labels go, then the status words, then the server chip. */
const HEAD_STEPS = ["full", "compact", "tight", "min"] as const;
/** A thread title cut shorter than this makes the top line give up something else. */
const TITLE_ROOM = 150;

/** Show the most of each bot chip that lets the whole row fit: details, then usage levels, go first. Names go last; the avatars always stay. */
function fitChips(row: HTMLElement) {
  fitSteps(CHIP_STEPS, (step) => { row.dataset.fit = step; }, () => row.scrollWidth <= row.clientWidth);
}

/** Give up words on the pane's top line until it fits and the title keeps its room. */
function fitHead(head: HTMLElement) {
  const title = head.querySelector<HTMLElement>(".pane-title");
  head.removeAttribute("data-flag-hidden");
  fitSteps(HEAD_STEPS, (step) => { head.dataset.fit = step; }, () =>
    head.scrollWidth <= head.clientWidth && (!title || title.scrollWidth <= title.clientWidth || title.clientWidth >= TITLE_ROOM));
  // Still too wide at the last step: a flag ("New reply") goes rather than the buttons. The dot keeps its colour and names it.
  head.toggleAttribute("data-flag-hidden", Boolean(head.querySelector(".flag")) && head.scrollWidth > head.clientWidth);
}

/** Short avatar moves for saved-agent tiles; styles.css has one keyframe per name. */
export const TILE_MOVES = ["hop", "wiggle", "spin", "squash", "tilt", "pulse"];
/** Plays a random move on a tile's avatar, never the move that tile played last. */
export function playTileMove(tile: HTMLElement) {
  const choices = TILE_MOVES.filter((move) => move !== tile.dataset.last);
  const move = choices[Math.floor(Math.random() * choices.length)];
  delete tile.dataset.move;
  void tile.offsetWidth; // restart the animation
  tile.dataset.move = move;
  tile.dataset.last = move;
}
/** A saved agent in the add menu: ticks on click; hover or keyboard focus plays a move and scrambles its dots. */
function AgentTile({ name, seed, color, picked, onToggle }: { name: string; seed: string; color: string; picked: boolean; onToggle: () => void }) {
  const [scramble, setScramble] = useState(0);
  const play = (tile: HTMLElement) => { playTileMove(tile); setScramble((n) => n + 1); };
  return (
    <button type="button" className="quick-add-tile" style={{ "--ring": color } as CSSProperties} onClick={onToggle} role="checkbox" aria-checked={picked} onPointerEnter={(e) => play(e.currentTarget)} onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) play(e.currentTarget); }} onAnimationEnd={(e) => { if (e.animationName.startsWith("tile-")) delete e.currentTarget.dataset.move; }}>
      <span className="quick-add-tick" aria-hidden="true">✓</span>
      <Avatar seed={seed} color={color} scramble={scramble} />
      <span className="quick-add-tile-name">{name}</span>
    </button>
  );
}
/** No renames to apply: one array, so the default never looks like a change. */
const NO_RENAMES: CopyRename[] = [];

export function ChatPane({ voiceSettings, onVoiceSettings, onVoiceFocus, pane, cwd, workspaceName = "", onStatus, onSeen, addRequest, agents, backend, focused, visible = true, onActivity, onSignal, onApprovals, onServer, onPreview, onFork, moveAsk, work, menuRequest, onMenuDone, onCopy, profiles, onProfilesChange, disabledProviders, newThread = { policy: "mention", max_bot_hops: 3 }, newBotAccess = "read", confirmSteer = true, onConfirmSteer, chipParts = ALL_PARTS, landingTexture = DEFAULT_LANDING_TEXTURE, profileMode = false, copyRenames = NO_RENAMES, onCopyRenamed, details, artifactsHost, followArtifacts = false, countsSlot, attach = false, codeRunButtons = true, onOpenTerminal }: Props) {
  // Hydrate on first display, then keep the DOM so switching chats preserves
  // selection, scroll position, expanded messages and loaded media.
  const transcriptMounted = useRef(visible);
  if (visible) transcriptMounted.current = true;
  // Read when a thread is first made, so changing settings never restarts an open one.
  const defaults = useRef({ newThread, newBotAccess });
  defaults.current = { newThread, newBotAccess };
  const [participants, setParticipants] = useState<ParticipantConfig[]>(profileMode ? profiles : []);
  const [options, setOptions] = useState<RoomOptions>(newThread);
  const [entries, setEntries] = useState<Entry[]>([]);
  // Saved steps per finished reply: the index says which replies have them; a reply's own steps load when its line is opened.
  const [stepsIndex, setStepsIndex] = useState<import("./types").StepsIndex | null>(null);
  const loadedSteps = useRef(new Map<number, import("./types").ReplySteps>());
  const refreshSteps = useRef<() => void>(() => {});
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
  /** Prepaid dollars left on each custom provider account that offers a balance check. */
  const [balances, setBalances] = useState<Record<string, number>>({});
  /** How full each agent's context window was on its latest request. Missing
   *  means unknown: not reported yet, or refilled by /compact since. */
  const [contextFill, setContextFill] = useState<Record<string, ContextFill>>({});
  /** Goes up on each /compact, to play the left side's refill. */
  const [compactions, setCompactions] = useState(0);
  const plans = usePlans(backend.host?.id);
  /** The chip whose usage card is open. */
  const [card, setCard] = useState<string | null>(null);
  /** Where the hovered bot's usage card sits: above its badge, at the bottom of the pane. */
  const [cardAt, setCardAt] = useState<{ left: number; bottom: number } | null>(null);
  /** The open usage card, drawn on the page body so the Glass pane's blur cannot shift where it lands.
   *  React still passes its pointer, focus and key events up to the badge that opened it. */
  const cardBox = useRef<HTMLDivElement | null>(null);
  /** A short wait before the card closes, so the pointer can cross from the badge to the card. */
  const cardClose = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepCard = () => clearTimeout(cardClose.current);
  const leaveCard = (id: string) => { keepCard(); cardClose.current = setTimeout(() => setCard((open) => (open === id ? null : open)), 200); };
  useEffect(() => keepCard, []);
  const hoverCard = (id: string, badge: HTMLElement) => { keepCard(); setCard(id); setCardAt(aboveAnchor(badge.getBoundingClientRect(), viewport(), USAGE_CARD_WIDTH)); };

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
  /** Scope the changes panel to one reply's files, set by its strip. Null shows everything. */
  const [turnPaths, setTurnPaths] = useState<string[] | null>(null);
  /** Which file to auto-expand in the changes panel after a strip file click. Null expands none. */
  const [focusPath, setFocusPath] = useState<string | null>(null);
  /** Files each bot reply changed, from the change events' author and round offset. Model-agnostic. */
  const turnFiles = useMemo(() => turnFilesFor(messagesOf(entries), changes), [entries, changes]);
  const openTurnDiff = (seq: number, path?: string) => {
    const files = turnFiles.get(seq) ?? [];
    setTurnPaths(files.map((file) => file.path));
    setFocusPath(path ?? null);
    details?.show("changes");
    loadDiff();
  };
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
  const [replies, setReplies] = useState<ReplyQuote[]>([]);
  /** Whether the quote's Send to ▾ menu is open. */
  const [handOffOpen, setHandOffOpen] = useState(false);
  const handOffButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (replies.length === 0) setHandOffOpen(false); }, [replies.length]);
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
  /** Where the quick add menu is open: grown out of the message box, or in the sidebar. */
  const [quickAdd, setQuickAdd] = useState<"dock" | "details" | null>(null);
  /** True once the person types a name, so choosing a model stops renaming the bot. */
  const nameTouched = useRef(false);
  /** New bots set up and waiting in the quick add batch, oldest first. */
  const [queuedBots, setQueuedBots] = useState<Draft[]>([]);
  /** Ids of saved agents ticked in the quick add menu. */
  const [pickedAgents, setPickedAgents] = useState<Set<string>>(new Set());
  /** Whether the quick add editor is open and counts as one more new bot. */
  const [editorOpen, setEditorOpen] = useState(false);
  /** Remount the persona writer when switching drafts, cancelling late answers. */
  const [quickPersonaId, setQuickPersonaId] = useState(0);
  useEffect(() => {
    if (!quickAdd) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".quick-add-wrap, .quick-add")) setQuickAdd(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setQuickAdd(null); } };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key, true); };
  }, [quickAdd]);
  /** The docked add menu, so focus can move into it when it opens. */
  const quickAddForm = useRef<HTMLFormElement>(null);
  useEffect(() => { if (quickAdd) quickAddForm.current?.querySelector<HTMLElement>(".quick-add-tile, .quick-add-another")?.focus(); }, [quickAdd]);
  /** The button that opened the add menu, so focus can go back to it on close. */
  const quickAddOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const back = quickAddOpener.current;
    if (quickAdd || !back) return;
    quickAddOpener.current = null;
    if (document.activeElement === document.body || document.activeElement === null) {
      (back.isConnected ? back : input.current)?.focus();
    }
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
  const [apiModels, setApiModels] = useState<ApiModel[]>([]);
  const [modelNote, setModelNote] = useState("");
  /** Where the form's API key would come from on this machine. */
  const [keyState, setKeyState] = useState<KeyState | null>(null);
  /** What each coding agent reports it can use, asked once per tool. */
  const [reported, setReported] = useState<Partial<Record<AgentTool, ModelChoice[]>>>({});
  const [formError, setFormError] = useState("");
  /** The id of the participant being edited, or null when adding a new one. */
  const editingBase = useRef<ParticipantConfig | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [roomReady, setReady] = useState(profileMode);
  const hostConnection = useHostConnection(backend);
  const ready = roomReady && hostCanMutate(hostConnection.status);
  const [loadError, setLoadError] = useState("");
  /** Structured attach-mode waiting state: the owner hasn't opened the room yet. Drives the retry loop. */
  const [waitingForOwner, setWaitingForOwner] = useState(false);

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
  useEffect(() => {
    const insert = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId: string; text: string }>).detail;
      if (detail?.paneId !== pane.id || !detail.text) return;
      const field = input.current;
      const caret = field?.selectionStart ?? text.length;
      const next = insertAt(text, null, caret, detail.text);
      setText(next.text); setCaret(next.caret);
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
    };
    window.addEventListener(INSERT_COMPOSER_EVENT, insert);
    return () => window.removeEventListener(INSERT_COMPOSER_EVENT, insert);
  }, [pane.id, text]);
  const composer = useRef<HTMLDivElement>(null);
  // Grow the message box with its text, up to the CSS max-height.
  useLayoutEffect(() => {
    if (input.current) fitHeight(input.current);
  }, [text]);
  // Refit when its width changes: a pane opened from hiding, or resized so
  // the text wraps differently. Height changes are its own and are skipped.
  useEffect(() => {
    const box = input.current;
    if (!box) return;
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      fitHeight(box);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  /** Whether the transcript sat at its bottom when it was last scrolled. New
   *  content follows only then; scrolled up, the transcript keeps your place. */
  const stuck = useRef(true);
  /** Bot replies that arrived while you were scrolled up. */
  const [unread, setUnread] = useState(0);
  /** The chat's root element; its pane's size decides what fits. */
  const root = useRef<HTMLDivElement>(null);
  // The empty landing screen extends its texture under the composer.
  useEffect(() => {
    const box = composer.current;
    if (!box) return;
    const publish = () => root.current?.style.setProperty("--composer-h", `${box.offsetHeight}px`);
    publish();
    const obs = new ResizeObserver(publish);
    obs.observe(box);
    return () => obs.disconnect();
  }, [profileMode]);
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
  /** Send was pressed: from then on the thread has started and stays where it runs. */
  const [sendingFirst, setSendingFirst] = useState(false);
  /** Where the room was last opened, to tell a move to another machine or folder. */
  const place = useRef<{ backend: Backend; cwd: string } | null>(null);
  const [tldr, setTldr] = useState(() => loadTldr(pane.id));
  const [folded, setFolded] = useState(() => loadFolded(pane.id));
  const toggleFolded = () => setFolded((on) => { saveFolded(pane.id, !on); return !on; });
  const toggleTldr = () => setTldr((on) => { saveTldr(pane.id, !on); return !on; });
  // The thread's Plan switch, as the host keeps it.
  const [planOn, setPlanOn] = useState(false);
  const setPlan = (on: boolean) => backend.roomSetPlan(pane.id, on).catch((error) => notify(`Could not ${on ? "turn Plan on" : "turn Plan off"}: ${String(error)}`, "error"));
  // The form above the composer: a bot's question, or next steps after a reply.
  const questionState = useSyncExternalStore(subscribeQuestions, questionSnapshot);
  const form = formView(questionState[pane.id]);
  const [highlighted, setHighlighted] = useState(-1);
  const [formFolded, setFormFolded] = useState(false);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  /** What the person answered each waiting bot, shown in its turn until it finishes. */
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const answeredHere = useRef<string | null>(null);
  const shownForm = useRef<FormView>(form);
  const formKeyId = form.kind === "question" ? form.ask.request : form.kind === "steps" ? `steps:${form.offer.steps.map((step) => step.prompt).join("|")}` : form.kind;
  useEffect(() => { setHighlighted(-1); setFormFolded(false); }, [formKeyId]);
  useEffect(() => { shownForm.current = form; });
  const flashForm = (line: string) => { setFormNotice(line); setTimeout(() => setFormNotice((now) => (now === line ? null : now)), 3500); };
  const field = useRef<HTMLDivElement>(null);
  // A very narrow box puts the text on its own line, with +, TL;DR and Send under it.
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const box = field.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width) setStacked(entry.contentRect.width < STACK_PX); });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
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
  /** Who a quote will lead with right now, for its Send to ▾ button. */
  const quoteTo = !replies.length ? null : quoteTarget(text.trim(), replies, participants);

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

  const messageNumbers = useRef(messageDedup()).current;

  const notify = (message: string, tone: Notice["tone"] = "info", action?: NoticeAction, source?: Notice["source"]) =>
    setEntries((list) => [...list, { kind: "notice", notice: { key: noticeKey.current++, text: message, tone, ...(source ? { source } : {}), ...(action ? { action } : {}) } }]);

  useEffect(() => {
    if (profileMode) return;
    let alive = true;
    const nameOf = (id: string) => namesRef.current.get(id) ?? id;
    /** Tell the app what this thread's open cards want. The store has seen the event already (hub.ts). */
    const reportApprovals = () => approvals.current?.(pane.id, approvalSignal(openCards(pane.id), namesRef.current, Date.now()) ?? questionSignal(questionSnapshot()[pane.id], namesRef.current));
    let recoveredState: import("./types").RoomState | null = null;
    loadedSteps.current.clear();
    const stepsLoader = createStepsIndexLoader(
      () => backend.roomSteps(pane.id, null),
      (index) => {
        if (!alive) return;
        // A reply whose entry is gone (rewind, edit) must not keep showing old steps.
        for (const seq of [...loadedSteps.current.keys()]) if (!index?.replies[String(seq)]) loadedSteps.current.delete(seq);
        setStepsIndex(index);
      },
    );
    refreshSteps.current = () => { void stepsLoader.refresh(); };
    const durableRecovery = createRoomTotalsRefresh({
      // Attach mode never touches lifecycle reads either; usage arrives with the attached snapshot on live backends.
      load: () => attach ? Promise.resolve({ usage: {}, changes: [] }) : loadRoomTotals(backend, pane.id),
      apply: saved => {
        if (!alive || !recoveredState || recoveredState.recovery_seq != null) return;
        setUsed(saved.usage ?? {});
        setChanges((saved.changes ?? []).map(c => ({ seq: c.seq, by: c.by, change: { path: c.path, added: c.added, removed: c.removed, diff: "" } })));
      },
      fail: error => { if (alive) notify(`Could not refresh chat totals: ${String(error)}`, "error"); },
    });
    const onEvent = (event: RoomEvent) => {
      if (!alive) return;
      if (recoveredState && representedRoomEvent(recoveredState, event)) return;
      if (event.type === "message_added") {
        if (!messageNumbers.accept(event.message.seq)) return;
      }
      recordApproval(pane.id, event, backend.host?.id);
      recordQuestion(pane.id, event);
      if (event.type === "question_requested") reportApprovals();
      if (event.type === "question_resolved") {
        reportApprovals();
        if (event.end === "answered" && event.request !== answeredHere.current) flashForm("Answered on another device");
      }
      activity.current(pane.id);
      const heardId = heardFrom(event);
      if (heardId) heard.current.set(heardId, Date.now());
      if (event.type === "tool_servers") { setServerErrors(errors => { const next = {...errors}; delete next[event.id]; return next; }); setServerLists(lists => ({...lists, [event.id]: event.servers})); return; }
      switch (event.type) {
        case "participants_changed":
          setParticipants(event.participants);
          break;
        case "participant_changed":
          setParticipants(list => list.map(p => p.id === event.participant.id ? event.participant : p));
          break;
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
          setAnswered(({ [event.id]: _said, ...rest }) => rest);
          setPendingSettings(({ [event.id]: _applied, ...rest }) => rest);
          setDrafts(({ [event.id]: _done, ...rest }) => rest);
          setWorking(({ [event.id]: _done, ...rest }) => rest);
          reportApprovals();
          turnQueue.idle(event.id);
          heard.current.delete(event.id);
          collectWritten.current(event.id);
          refreshSteps.current();
          break;
        case "turn_started":
          turnQueue.started(event.id);
          setDrafts((d) => ({ ...d, [event.id]: "" }));
          setNow(Date.now());
          setWorking((w) => ({ ...w, [event.id]: { startedAt: Date.now(), steps: [], work: emptyTurnSteps, phase: "thinking" } }));
          break;
        case "delta":
          setDrafts((d) => ({ ...d, [event.id]: (d[event.id] ?? "") + event.text }));
          setWorking((w) => (w[event.id] && w[event.id].phase !== "writing" ? { ...w, [event.id]: { ...w[event.id], phase: "writing" } } : w));
          break;
        case "activity":
          setWorking((w) => {
            const turn = w[event.id] ?? { startedAt: Date.now(), steps: [], work: emptyTurnSteps, phase: "thinking" as const };
            return { ...w, [event.id]: { ...turn, steps: [...turn.steps, event.text], phase: "tool" } };
          });
          break;
        case "work_step":
        case "todo":
          // A helper can report after its bot's turn ended; only a running turn shows steps.
          setWorking((w) => {
            const turn = w[event.id];
            if (!turn) return w;
            const work = applyStepEvent(turn.work, event);
            return work === turn.work ? w : { ...w, [event.id]: { ...turn, work } };
          });
          break;
        case "approval_requested":
        case "approval_resolved":
          // The turn is stuck until the person answers, wherever they are
          // looking, so the flag is blocking until the last card is answered.
          reportApprovals();
          break;
        case "changed":
          if (recoveredState?.recovery_seq == null) void durableRecovery.refresh();
          else setChanges((list) => [...list, { seq: list.length, by: event.id, change: event.change }]);
          written.current.set(event.change.path, event.id);
          break;
        case "allowed_changed":
          setAllowed(event.allowed);
          break;
        case "plan_changed":
          setPlanOn(event.on);
          break;
        case "usage":
          if (recoveredState?.recovery_seq == null) { void durableRecovery.refresh(); break; }
          setUsed((u) => {
            const before = u[event.id] ?? { input: 0, output: 0, turns: 0 };
            // A missing cost is counted as unknown, never as $0. An estimate is kept apart from reported spend.
            const cost = event.cost_micros;
            const estimate = cost != null && event.cost_estimated === true;
            return { ...u, [event.id]: {
              input: before.input + (event.input_tokens ?? 0),
              output: before.output + (event.output_tokens ?? 0),
              turns: before.turns + 1,
              cost_micros: (before.cost_micros ?? 0) + (cost != null && !estimate ? cost : 0),
              unknown_cost_turns: (before.unknown_cost_turns ?? 0) + (cost == null ? 1 : 0),
              estimated_cost_micros: (before.estimated_cost_micros ?? 0) + (cost != null && estimate ? cost : 0),
            } };
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
          const roster = [...namesRef.current].map(([id, display_name]) => ({ id, display_name }));
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
          setEntries((list) => list.some(e => e.kind === "summary" && e.summary.upto === event.upto && e.summary.summary === event.summary)
            ? list : [...list, { kind: "summary", summary: { by: event.id, summary: event.summary, upto: event.upto } }]);
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
          turnQueue.roomIdle();
          refreshSteps.current();
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
    };
    // App moved this thread before it started: it reopens where it runs now. Files
    // attached on another machine stay there, so they come off the message.
    const before = place.current;
    place.current = { backend, cwd };
    if (before && before.backend !== backend && attached.length > 0) {
      setAttached([]);
      notify("Attached files stay on the machine they were sent to. Attach them again here.");
    }
    // Attach mode reads again while the owner hasn't opened the room; cancelled on unmount or room change.
    const attachRetry = createAttachRetry(() => { if (alive) void refresh(); });
    const recovery = createRoomRecovery({
      // Attach mode reads the owner's room without creating it; a missing room waits for the owner.
      load: () => attach ? loadRoomAttach(backend, pane.id) : loadRoomState(backend, pane.id, pane.sample ? SAMPLE_BOTS : [], defaults.current.newThread, cwd),
      apply: (state) => {
        if (!alive) return;
        const saved = state.snapshot;
        recoveredState = state;
        refreshSteps.current();
        messageNumbers.restore(saved.transcript);
        forgetRoom(pane.id);
        state.approvals.forEach(ask => recordApproval(pane.id, { type: "approval_requested", ...ask }, backend.host?.id));
        // A question the pane was showing that the host no longer has was
        // lost with the bot's turn, as when Deck restarted.
        const before = shownForm.current;
        restoreRoomQuestions(pane.id, state);
        setPlanOn(Boolean(state.plan ?? saved.plan));
        if (before.kind === "question" && !(state.questions ?? []).some((q) => q.request === before.ask.request)) {
          flashForm(`${nameOf(before.ask.id)}'s question was dropped when Deck restarted`);
        }
        reportApprovals();
        setWorking(Object.fromEntries(state.active.map(id => [id, { startedAt: Date.now(), steps: [], work: emptyTurnSteps, phase: "thinking" as const }])));
        turnQueue.state = {}; state.active.forEach(id => turnQueue.started(id));
        setBusy(state.active.length > 0 || turnQueue.active);
        setDrafts(Object.fromEntries(state.active.map(id => [id, ""])));
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
        setEntries(old => [...restored, ...old.filter(e => e.kind === "notice" && e.notice.source !== "room-load")]);
        // Open at "New since you looked" when replies came in after you last looked.
        const seen = seenList(saved.transcript);
        const from = firstUnseen(seen, lastSeenRef.current);
        setDividerAt(from);
        if (from !== null) {
          opening.current = true;
          setUnread(unseenCount(seen, from));
        }
        setLoadError("");
        setWaitingForOwner(false);
        attachRetry.reset();
        setReady(true);
        reportApprovals();
      },
      fail: error => {
        if (!alive) return;
        setReady(false); setLoadError(String(error));
        // An attached view whose owner hasn't opened the room waits quietly and reads again; it never creates it.
        const waiting = attach && isWaitingForOwner(error);
        setWaitingForOwner(waiting);
        if (waiting) attachRetry.missed();
        else notify(`Could not load the chat: ${String(error)}`, "error", undefined, "room-load");
      },
      event: onEvent,
      represented: representedRoomEvent,
    });
    const unregister = registerRoom(pane.id, (event: RoomEvent) => { if (!recovery.capture(event)) onEvent(event); }, backend.host?.id,
      event => !recoveredState || !representedRoomEvent(recoveredState, event));
    const refresh = async () => {
      if (!alive) return;
      const state = backend.host?.connection.get();
      if (state && state.status.kind !== "connected" && state.status.kind !== "resync") return;
      setReady(false);
      recoveredState = null; // a new daemon boot starts its room event numbers over
      await recovery.refresh();
    };
    const offRecovery = backend.host?.connection.recover?.(refresh, recovery.pending) ?? (() => {});
    let offHub = () => {};
    void startHub(backend, backend.host?.id).then(off => {
      if (!alive) { off(); return; }
      offHub = off;
      // Connected already, or browser demo. Otherwise first connection runs refresh.
      if (!backend.host || backend.host.connection.get().revision > 0) void refresh();
    });
    return () => {
      alive = false;
      attachRetry.dispose();
      recovery.dispose(); offRecovery();
      durableRecovery.dispose();
      offHub();
      unregister();
      forgetRoom(pane.id);
      forgetQuestions(pane.id);
      approvals.current?.(pane.id, null);
      // Attach mode only watches: closing the view must never close the owner's room.
      if (!attach) backend.roomClose(pane.id).catch(() => {});
    };
    // The room lives as long as the pane, where the pane runs. A thread that
    // hasn't started can be moved (App imports it there first), so it reopens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, profileMode, backend, cwd, attach]);

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
  const pathChecks = useMemo(() => new Map<string, Promise<boolean>>(), [cwd, backend]);
  const pathExists = useCallback((path: string) => {
    let known = pathChecks.get(path);
    if (!known) {
      known = backend.pathsExist([path], cwd || null).then(([yes]) => Boolean(yes), () => false);
      pathChecks.set(path, known);
    }
    return known;
  }, [pathChecks, cwd, backend]);

  // A model's picture lives outside Deck (Codex and Grok keep their own); the
  // Library takes a copy the first time it is shown. One reader per bot, so
  // pictures aren't read again on every render.
  const replyReaders = useMemo(() => new Map<string, (path: string) => Promise<ArrayBuffer>>(), [pane.id, backend]);
  const readReplyImage = useCallback((by: string) => {
    let read = replyReaders.get(by);
    if (!read) replyReaders.set(by, read = (path) => backend.importReplyImage(pane.id, path, by).then(backend.readAttachment));
    return read;
  }, [replyReaders, pane.id, backend]);

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
  useLayoutEffect(() => settle.current(), [entries, drafts, asks, dividerAt, visible]);
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

  /** Save a typed key to this machine and point the draft at it. A draft with no key named picks up one already saved for its provider. */
  const withKey = async (draft: Draft): Promise<Draft> => {
    if (!takesKey(draft.preset)) return draft;
    const name = keyNameOf(draft);
    if (draft.apiKey?.trim()) {
      if (!name) throw new Error("Give the bot a name first, so its key can be saved.");
      await backend.apiKeySave(name, draft.apiKey);
      setDraft((d) => ({ ...d, keyEnv: name, apiKey: "" }));
      setKeyState("saved");
      return { ...draft, keyEnv: name, apiKey: "" };
    }
    return !draft.keyEnv.trim() && name && keyState && keyState !== "missing" ? { ...draft, keyEnv: name } : draft;
  };

  const saveParticipant = async () => {
    if (!editing && !providerEnabled(draft.preset, disabledProviders)) return setFormError("This provider is disabled. Enable it in Providers to add a bot.");
    let ready: Draft;
    try { ready = await withKey(draft); } catch (error) { return setFormError(error instanceof Error ? error.message : String(error)); }
    const built = draftToConfig(ready);
    if (typeof built === "string") return setFormError(built);
    // The id a bot is saved under never changes; its @mention follows its name.
    const identity = botIdentity(built, { editing, others: participants, agents: profiles, place: profileMode ? "agents" : "chat" });
    if ("error" in identity) return setFormError(identity.error);
    const config = { ...built, id: identity.id, appearance: built.appearance ?? (editing ? appearance(editing) : createAppearance([...identities.current.values()])) };
    try {
      if (profileMode) {
        const next = editing ? participants.map((p) => p.id === editing ? config : p) : [...participants, config];
        setParticipants(next);
        onProfilesChange(next);
      } else if (editing) {
        const saved = await backend.roomUpdateParticipant(pane.id, config, editingBase.current ?? undefined);
        // Attach mode never creates the room: a popped view edits only while the owner has it open.
        if (!saved && attach) return setFormError("This chat isn't open in Deck right now. Return it to Deck and try again.");
        const actual = saved || (await backend.roomCreate(pane.id, [], { policy: "mention", max_bot_hops: 0 }, "")).participants.find(p => p.id === config.id) || config;
        if (!saved) setParticipants((list) => list.map((p) => (p.id === editing ? actual : p)));
        if (profiles.some(p => p.id === editing)) onProfilesChange(profiles.map(p => p.id === editing ? { ...p, appearance: config.appearance } : p));
      } else {
        await backend.roomAddParticipant(pane.id, config);
        setParticipants((list) => list.some(p => p.id === config.id) ? list : [...list, config]);
      }
      if (config.backend.kind === "agent" && config.backend.model) rememberModel(draft.preset, config.backend.model);
      closeForm(draft.preset);
      return true;
    } catch (error) {
      setFormError(String(error));
    }
  };

  const startEditing = (config: ParticipantConfig) => {
    editingBase.current = config;
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
      if (profileMode) { setParticipants(next); onProfilesChange(next); }
      else setParticipants(list => list.filter(p => p.id !== id));
    } catch (error) { notify(`Could not remove the bot: ${String(error)}`, "error"); return; }
    if (editing === id) closeForm(draft.preset);
  };
  /** Kick: take a bot out from its chip at once, with Undo in the thread instead of a confirm box. */
  const kick = async (p: ParticipantConfig) => {
    setCard(null);
    if (quickSettings?.id === p.id) setQuickSettings(null);
    try { await backend.roomRemoveParticipant(pane.id, p.id); }
    catch (error) { notify(`Could not kick ${p.display_name}: ${String(error)}`, "error"); return; }
    setParticipants((list) => list.filter((q) => q.id !== p.id));
    notify(`${p.display_name} was kicked.`, "info", { kind: "rejoin", config: p });
  };

  // An agent renamed in the Agents tab: rename this chat's copy of it, once,
  // when the chat can take changes. A chat opened after the rename skips it.
  // One rename at a time, so a second one made while the first saves isn't lost.
  const renamedUpTo = useRef(copyRenames.at(-1)?.seq ?? 0);
  const renaming = useRef({ room: pane.id, participants, backend, onCopyRenamed });
  renaming.current = { room: pane.id, participants, backend, onCopyRenamed };
  const [renameCopies] = useState(() => copyRenamer(() => renaming.current.participants, async (next, base) => {
    await renaming.current.backend.roomUpdateParticipant(renaming.current.room, next, base);
    // The next rename starts from this list, so it shows the new name now, not once the chat's update arrives.
    const named = (list: ParticipantConfig[]) => list.map((p) => (p.id === next.id ? { ...p, display_name: next.display_name } : p));
    renaming.current.participants = named(renaming.current.participants);
    setParticipants(named);
  }, (seq, outcome) => renaming.current.onCopyRenamed?.(seq, outcome)));
  useEffect(() => {
    if (profileMode || !ready) return;
    const due = copyRenames.filter((r) => r.seq > renamedUpTo.current);
    if (due.length === 0) return;
    renamedUpTo.current = due[due.length - 1].seq;
    void renameCopies(due, pane.title);
  }, [copyRenames, ready]);

  /** Counts finished saves, so the recipients are asked again once the room has the new Who answers. */
  const [optionsSaved, setOptionsSaved] = useState(0);
  const changeOptions = (next: RoomOptions) => {
    // Show the change at once, so a second quick click builds on this one rather than on the saved copy.
    setOptions(next);
    backend.roomSetOptions(pane.id, next).then(() => setOptionsSaved(n => n + 1)).catch((error) => notify(`Could not save chat settings: ${String(error)}`, "error"));
  };

  /** Empty the chat so the models start fresh. The participants stay. */
  const clearChat = () => {
    setText("");
    setReplies([]);
    backend
      .roomClear(pane.id)
      .then(() => {
        discardAnswerSettingsAfter(answerCurrent.current, 0);
        messageNumbers.truncate(0);
        loadedSteps.current.clear();
        setStepsIndex(null);
        refreshSteps.current();
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
    setReplies([]);
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
  // The queue lives as long as the pane; a thread moved before it started runs somewhere else, so it asks the current backend.
  const current = useRef(backend);
  current.current = backend;
  // The thread only hears a tag once its message is posted, so an untagged message behind a queued tag goes where that tag goes.
  const routing = useRef({ people: [] as ParticipantConfig[], policy: options.policy });
  routing.current = { people: participants, policy: options.policy };
  const stickyFor = (message: string, items: readonly ParticipantMessage[]) => queuedSticky(message, routing.current.people, routing.current.policy, items);
  const voiceBridges = useRef(new Map<string, ReturnType<typeof createThreadVoiceBridge>>());
  const [turnQueue] = useState(() => new ParticipantQueues(
    async (message): Promise<string[]> => stickyFor(message, turnQueue.items) ?? current.current.roomTargets(pane.id, message),
    async (message, to, kind, hops, voice) => {
      if (!voice) return dispatch.current(message, to, kind, hops);
      try { await current.current.roomPostTo(pane.id, message, to, false, {client_turn_id:voice.requestId,max_bot_hops:0}); }
      catch(error) { voiceBridges.current.get(to[0])?.fail(voice.requestId,error); throw error; }
    },
    id => current.current.roomStop(pane.id, id),
    // A one-off turn has no text to show or edit, so the queue line leaves it out.
    items => { setQueued(items.filter(item => item.kind !== "turn")); setBusy(turnQueue.active); setQueuePaused(turnQueue.paused.size > 0 || turnQueue.connectionPaused); },
    error => { notify(`Could not send: ${String(error)}. Affected queues are paused. Check whether it arrived before retrying.`, "error"); },
    () => !current.current.host || hostCanMutate(current.current.host.connection.get().status),
  ));
  useEffect(() => {
    const store = backend.host?.connection;
    if (!store) return;
    const changed = () => turnQueue.availabilityChanged();
    changed(); return store.subscribe(changed);
  }, [backend, turnQueue]);
  const voiceHost=backend.host?.id??'local';
  const voiceConfig=readVoiceSettings(voiceSettings);
  const voiceCandidates=profileMode?[]:participants.filter(p=>!p.media).map(p=>({hostId:voiceHost,roomId:pane.id,participantId:p.id,profileId:p.id,name:p.display_name,aliases:preferenceFor(voiceConfig,voiceHost,p.id,pane.id,p.id).aliases}));
  const voiceWho:VoiceWho=id=>{const p=participants.find(x=>x.id===id),look=appearance(id);return {...look,kind:p?.backend.kind==='agent'?AGENT_LABEL[p.backend.tool]:undefined};};
  const voiceHint=useVoiceHint({candidates:voiceCandidates,settings:voiceConfig});
  const voiceSlot=useVoiceSlot({candidates:voiceCandidates,settings:voiceConfig});
  const roundButton=composerButton({hasContent:!!text.trim()||sendable.length>0,canCall:!!window.apexDeck?.voice&&voiceCandidates.length>0,live:voiceSlot.live,look:voiceSlot.look});
  const voiceLive=useRef({ready,participants,voiceCandidates,voiceConfig,onVoiceSettings,onVoiceFocus});
  voiceLive.current={ready,participants,voiceCandidates,voiceConfig,onVoiceSettings,onVoiceFocus};
  useEffect(()=>{
    const key=scopeKey({hostId:voiceHost,roomId:pane.id});
    return ()=>{unregisterVoiceThread(key);for(const bridge of voiceBridges.current.values())bridge.dispose();voiceBridges.current.clear();};
  },[backend,pane.id,voiceHost]);
  useEffect(()=>{
    if(profileMode)return;
    registerVoiceThread(scopeKey({hostId:voiceHost,roomId:pane.id}),{
      candidates:voiceCandidates,settings:voiceConfig,save:s=>voiceLive.current.onVoiceSettings?.(s),focus:()=>voiceLive.current.onVoiceFocus?.(pane.id),
      bridge:id=>{
        let bridge=voiceBridges.current.get(id);if(bridge)return bridge;
        bridge=createThreadVoiceBridge({backend,scope:{hostId:voiceHost,roomId:pane.id,participantId:id},
          enqueue:async (turn:VoiceTurn,isCanceled:()=>boolean)=>{
            if(!voiceLive.current.ready||!voiceLive.current.participants.some(p=>p.id===id))throw Error('Agent thread is unavailable');
            // Same mod validation as typed sends, without command parsing or draft mutation.
            const hooked=await modHost.promptSubmit(pane.id,turn.text);
            if(hooked.deny)throw Error(hooked.deny);
            if(!hooked.text?.trim())throw Error('Voice transcript was empty after prompt processing');
            const invalid=resolveServerRequests(parseServerRequests(hooked.text).map(s=>s.name),serverLists[id]??[]).unknown;
            if(invalid.length)throw Error(`No tool server called ${invalid[0]} for this agent`);
            if(isCanceled())throw Error("Voice turn canceled");
            return turnQueue.sendTo(hooked.text,[id],{requestId:turn.requestId,canceled:isCanceled});
          },remove:requestId=>{const item=turnQueue.items.find(i=>i.voice?.requestId===requestId);if(!item)return false;turnQueue.remove(item.id);return true;}});
        voiceBridges.current.set(id,bridge);return bridge;
      },
    });
  });
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
    if (action.kind === "rejoin") {
      if (!liveKeys.has(key) || participants.some((p) => p.id === action.config.id)) return null;
      return <button type="button" className="ghost small" onClick={() => {
        if (usedActions.current.has(key)) return;
        usedActions.current.add(key);
        setUsedKeys(new Set(usedActions.current));
        backend.roomAddParticipant(pane.id, action.config)
          .then(() => setParticipants((list) => list.some((p) => p.id === action.config.id) ? list : [...list, action.config]))
          .catch((error) => notify(`Could not bring ${action.config.display_name} back: ${String(error)}`, "error"));
      }}>Undo</button>;
    }
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
    return flushAnswerStores(backend, pane.id).then(() => onFork(title, upto, upto ?? messagesOf(entries).length))
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
    const next = pickedQuote(picked);
    setReplies((list) => list.some((q) => q.id === next.id && q.name === next.name && q.text === next.text) ? list : [...list, next]);
    setPicked(null);
    window.getSelection()?.removeAllRanges();
    input.current?.focus();
  };
  const explainPicked = () => {
    if (!picked || !ready || participants.length === 0) return;
    const message = replyText("Explain this part in more detail.", pickedQuote(picked), participants);
    setPicked(null);
    window.getSelection()?.removeAllRanges();
    stuck.current = true;
    void turnQueue.send(message).catch((error) => notify(String(error), "error"));
  };
  const retryIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  const revertIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4v3.5h3.5M3.4 7.3A5 5 0 1 1 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  /** The Retry or Revert waiting on its confirmation. */
  const [goingBack, setGoingBack] = useState<{ kind: GoBack; message: Message; plan: RevertPlan; scope: RevertScope; ticked: string[] } | null>(null);
  /** Invalidates generated approval when Retry or Revert starts, before history or files can change. */
  const [goneBack, setGoneBack] = useState(0);
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
    setGoneBack((n) => n + 1);
    void backend.roomRevert(pane.id, message.seq, bot, request.chat, request.files).then((failed) => {
      if (request.chat) discardAnswerSettingsAfter(answerCurrent.current, message.seq);
      if (request.chat) messageNumbers.truncate(message.seq);
      if (request.chat) {
        setStepsIndex((index) => dropStepsFrom(index, loadedSteps.current, message.seq));
        refreshSteps.current();
      }
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
  /** Directional disclosure for message actions; the row wraps in a narrow pane. */
  const messageActions = (message: Message) => {
    const quote = () => { const next = quoteFor(message, (id) => names.get(id) ?? id); setReplies((list) => list.some((q) => q.id === next.id && q.name === next.name && q.text === next.text) ? list : [...list, next]); input.current?.focus(); };
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
      message.speaker.kind === "bot" && <ReadAloudAction key="read-aloud" text={message.text} />,
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
  const threadExport = async (): Promise<ThreadExport> => {
    await answersReady.current;
    return { title: pane.title, participants, transcript: messagesOf(entries), pins, compaction: compactionOf(entries), answers: answerCurrent.current?.entries() };
  };
  /** Save the thread. Resolves with the path, "" when the browser started a download, or null if nothing was saved. */
  const saveExport = async (format: "markdown" | "json"): Promise<string | null> => {
    const at = new Date();
    const thread = await threadExport();
    const contents = format === "json" ? exportJson(thread, at) : exportMarkdown(thread, at);
    const path = await backend.exportThread(exportFileName(pane.title, format, at), contents);
    if (path) return path;
    return backend.demo ? "" : null;
  };
  /** Save the thread to Downloads as Markdown or JSON, then show the file. */
  const exportAs = (format: "markdown" | "json") => {
    saveExport(format)
      .then((path) => { if (path) { notify(`Exported to ${path}`); openTarget(path, true); } })
      .catch((error) => notify(`Could not export: ${String(error)}`, "error"));
  };
  const sharePdf = async () => {
    const at = new Date();
    try {
      const thread = await threadExport();
      const path = await backend.exportPdf(exportFileName(pane.title, "pdf", at), exportHtml(thread, at));
      if (path) {
        notify(`Saved PDF to ${path}`);
        openTarget(path, true);
        return;
      }
      notify("The PDF was not saved.", "error");
    } catch (error) {
      let markdown: string | null = null;
      try {
        markdown = await saveExport("markdown");
      } catch (fallback) {
        notify(`Could not save a PDF or a Markdown file: ${String(fallback)}`, "error");
        return;
      }
      if (markdown) notify(`Couldn't make a PDF, saved Markdown instead: ${String(error)} (${markdown})`, "error");
      else if (markdown === "") notify(`Couldn't make a PDF, saved Markdown instead: ${String(error)}`, "error");
      else notify(`Could not save a PDF or a Markdown file: ${String(error)}`, "error");
    }
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
        setText(""); setTurnPaths(null); setFocusPath(null); details?.show("changes"); loadDiff(); return;
      case "plan":
        setText(""); void setPlan(!planOn); return;
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
  // Fork, Export or Share from a ⋯ menu. Wait until the transcript has loaded.
  // Tell App as soon as it is taken so closing and reopening cannot run it twice.
  const takenMenu = useRef("");
  useEffect(() => {
    if (!menuRequest || menuRequest.id === takenMenu.current) return;
    if (!ready) {
      if (!loadError) return;
      takenMenu.current = menuRequest.id;
      notify(`Couldn't open this chat, so nothing was saved: ${loadError}`, "error");
      onMenuDone?.(menuRequest.id);
      return;
    }
    takenMenu.current = menuRequest.id;
    const id = menuRequest.id;
    onMenuDone?.(id);
    if (menuRequest.action === "fork") void forkAt(`${pane.title} (fork)`, null);
    else if (menuRequest.action === "share_pdf") void sharePdf();
    else if (menuRequest.action === "copy_markdown") void threadExport().then(thread => onCopy?.(exportMarkdown(thread, new Date()), "markdown")).catch(error => notify(`Could not export: ${String(error)}`, "error"));
    else if (menuRequest.action === "copy_reply") onCopy?.(lastReply(messagesOf(entries)), "reply");
    else void saveExport("markdown").then((path) => { if (path) { notify(`Exported to ${path}`); openTarget(path, true); } }).catch((error) => notify(`Could not export: ${String(error)}`, "error"));
  }, [menuRequest, ready, loadError]); // eslint-disable-line react-hooks/exhaustive-deps

  // Artifacts: code from replies, opened on request, saved beside the thread.
  // A file that can't be read is never written over. See artifacts.ts.
  const [artifacts, setArtifacts] = useState<ArtifactFile>(EMPTY_ARTIFACTS);
  /** The newest file, ahead of the next render, so two changes in a row both land. */
  const latestArtifacts = useRef<ArtifactFile>(EMPTY_ARTIFACTS);
  const [artifactsLoaded, setArtifactsLoaded] = useState(false);
  const [artifactProblem, setArtifactProblem] = useState("");
  const [panel, setPanel] = useState<PanelView | null>(null);
  /** The side panel's Artifacts tab is showing this thread. */
  const dockedHere = Boolean(artifactsHost?.open && artifactsHost.target === pane.id);
  /** What the person sees: in the tab it's always this thread's artifacts, starting from the list's newest. */
  const liveView = artifactsHost ? (dockedHere ? panel ?? DEFAULT_VIEW : null) : panel;
  const mods = useMods();
  const modDock = mods.hostPane === pane.id ? mods.panes.filter((p) => !p.focus) : [];
  const artifactsReadable = useRef(false);
  const artifactSaves = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (profileMode) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = "";
    artifactsReadable.current = false;
    setArtifactsLoaded(false);
    if (hostConnection.revision === 0 && backend.host) return;
    const load = async () => {
      try {
        const next = readArtifacts(await backend.artifactsLoad(pane.id));
        if (!live) return;
        const encoded = JSON.stringify(next);
        if (encoded !== previous) {
          previous = encoded;
          latestArtifacts.current = next;
          setArtifacts(next);
        }
        artifactsReadable.current = !followArtifacts;
        setArtifactProblem("");
        setArtifactsLoaded(true);
      } catch {
        if (!live) return;
        setArtifactProblem("Artifacts couldn't be read, so changes here won't be saved.");
        setArtifactsLoaded(true);
      } finally {
        // Artifact saves have no service event. A standalone tab has one reader,
        // no overlapping requests, and never writes over Deck's authoritative file.
        if (live && followArtifacts) timer = setTimeout(load, 1000);
      }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [backend, pane.id, profileMode, hostConnection.revision, followArtifacts]);

  // Settings people chose on the cards in this thread's replies. See src/interactiveAnswers.
  const [answers, setAnswers] = useState<AnswerStore | null>(null);
  const answerCurrent = useRef<AnswerStore | null>(null);
  const answersReady = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    setAnswers(null);
    answerCurrent.current = null;
    if (profileMode) return;
    let live = true;
    const store = createAnswerStore(backend, pane.id);
    const release = retainAnswerStore(store);
    // Keep unsaved values and their base revisions across host recovery.
    // Writes resume only once recovery has reached Connected.
    let online = false;
    let refresh = Promise.resolve();
    const connection = backend.host?.connection;
    const connected = () => {
      const next = !connection || connection.get().status.kind === "connected";
      if (next && !online) refresh = refresh.then(async () => {
        await store.load();
        if (live) { answerCurrent.current = store; setAnswers(store); }
        await store.flush();
      });
      answersReady.current = refresh;
      online = next;
    };
    const stop = connection?.subscribe(connected);
    connected();
    return () => { live = false; stop?.(); void store.flush().finally(release); };
  }, [backend, pane.id, profileMode]);
  const versions = useMemo(() => cardVersions(messagesOf(entries)), [entries]);
  const autoStartKey = useMemo(() => latestGeneratedCardKey(messagesOf(entries)), [entries]);
  /** "Discuss these settings": the snapshot goes in the message box, never straight to the bots. */
  const discussCard = (snapshot: string) => {
    const next = discussDraft(text, snapshot);
    setText(next);
    setCaret(next.length);
    if (details?.overlay) details.close();
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.length, next.length); });
  };
  const cardIn = (message: Message) => (code: { language: string; text: string }) =>
    code.language === CARD_LANGUAGE
      ? <ThreadCard source={code.text} seq={message.seq} author={message.speaker.kind === "bot" ? names.get(message.speaker.id) ?? message.speaker.id : "Human"} versions={versions} answers={answers} threadId={pane.id} hostId={backend.host?.id ?? "local"} executionEpoch={`${hostConnection.revision}:${goneBack}:${cwd}`} executionAllowed={focused && ready} autoStartKey={autoStartKey} readOnly={message.speaker.kind !== "bot"} onDiscuss={discussCard} onOpen={openTarget} />
      : undefined;

  const changeArtifacts = (next: ArtifactFile) => {
    if (followArtifacts) return;
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
  useEffect(() => { if (liveView) setUnseenArtifacts(0); }, [liveView]);
  const panelWasOpen = useRef(false);
  const panelDismissed = useRef(false);
  useEffect(() => {
    // Moving the tab to another thread isn't closing it.
    if (panelWasOpen.current && !liveView && (!artifactsHost || artifactsHost.target === pane.id)) panelDismissed.current = true;
    panelWasOpen.current = liveView !== null;
  }, [liveView]);
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
    // In the side panel, only open it where it hides nothing and covers nothing.
    const roomy = artifactsHost ? artifactsHost.free && !artifactsHost.overlay && artifactsHost.target === pane.id : !narrow;
    if (artifactAutoOpen() && !panelDismissed.current && !typing && roomy) { showVersion(artifactId, n); return; }
    setUnseenArtifacts((count) => count + 1);
    setArtifactGlow(Date.now());
  };
  const announceArtifactLatest = useRef(announceArtifact);
  announceArtifactLatest.current = announceArtifact;
  collectWritten.current = (bot: string) => {
    if (followArtifacts) return;
    const paths = [...written.current].filter(([path, by]) => by === bot && kindForPath(path)).map(([path]) => path);
    for (const path of paths) written.current.delete(path);
    if (paths.length === 0 || !artifactsReadable.current) return;
    for (const path of paths) {
      backend.workspaceRead(path, cwd || null).then((source) => {
        if (source === null) return;
        const out = upsertFromFile(latestArtifacts.current, path, { source, by: bot, seq: null, at: Date.now() }, `art-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
        if (!out.added) return;
        changeArtifacts(out.file);
        if (out.artifact) announceArtifactLatest.current(out.artifact.id, out.artifact.versions.length);
      }, () => {});
    }
  };

  // HTML or SVG fenced in a live reply opens the same way. Replies loaded
  // with the thread don't: those were seen already.
  collectReply.current = (message) => {
    if (followArtifacts) return;
    if (!artifactsReadable.current || message.speaker.kind !== "bot") return;
    const code = parseBlocks(message.text).flatMap((block) => (block.kind === "code" ? [{ language: block.language, text: block.text }] : []));
    if (code.length === 0) return;
    const out = fromReply(latestArtifacts.current, code, { source: "", by: message.speaker.id, seq: message.seq, at: Date.now() }, `art-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    if (!out.artifact) return;
    changeArtifacts(out.file);
    announceArtifact(out.artifact.id, 1);
  };

  const showVersion = (artifactId: string, n: number) => {
    setPanel((view) => ({ ...(view ?? DEFAULT_VIEW), artifactId, n, list: false }));
    artifactsHost?.show();
  };
  const toggleArtifacts = () => {
    if (!artifactsHost) { setPanel((view) => (view ? null : DEFAULT_VIEW)); return; }
    artifactsHost.show();
  };

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

  const shownVersion = liveView && !liveView.list ? pickVersion(artifacts, liveView.artifactId, liveView.n) : null;
  /** The control for a code block in a finished bot reply, or nothing. */
  const artifactAction = (message: { seq: number; speaker: Speaker }, code: { language: string; text: string }) => {
    if (!artifactsLoaded) return null;
    const choices = codeChoices(artifacts, message.seq, code.language, code.text);
    if (!choices) return null;
    const showing = Boolean(shownVersion && choices.opened && shownVersion.artifact.id === choices.opened.artifactId && shownVersion.version.n === choices.opened.n);
    return <ArtifactButton choices={choices} showing={showing} onChoose={(choice) => openFromCode(message, code, choice)} />;
  };

  // Running a shell block from a bot's reply. The click is the consent; the
  // browser preview has no shell, so it gets no button.
  const codeRuns = useCodeRuns(backend, pane.id);
  const runKey = (message: { seq: number }, code: CodeInfo) => `${message.seq}:${code.index}`;
  const runAction = (message: { seq: number }, code: CodeInfo) => {
    if (!codeRunButtons || backend.demo || !isRunnable(code.language, code.text)) return null;
    const command = commandFrom(code.language, code.text);
    if (!command.trim()) return null;
    const key = runKey(message, code);
    return <RunButton command={command} running={codeRuns.runs[key]?.state === "running"} onRun={() => codeRuns.run(key, command, cwd)} />;
  };
  const runBelow = (message: { seq: number }, code: CodeInfo) => {
    const key = runKey(message, code);
    const run = codeRuns.runs[key];
    if (!run) return null;
    return (
      <CodeRunBox run={run} host={backend.host?.name ?? "This Mac"}
        onStop={() => codeRuns.stop(key)} onDismiss={() => codeRuns.dismiss(key)}
        onOpenTerminal={onOpenTerminal && (() => onOpenTerminal(run.command))}
        onAddToMessage={() => {
          const block = outputForMessage(run);
          setText((current) => current.trim() ? `${current.replace(/\s+$/, "")}\n\n${block}\n` : `${block}\n`);
          input.current?.focus();
        }} />
    );
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

  // The bot chips refit when the row resizes or any chip's text changes.
  const chipRow = useRef<HTMLDivElement>(null);
  const chipText = useRef<string | null>(null);
  useLayoutEffect(() => {
    const row = chipRow.current;
    if (!row || `${chipParts.style}:${folded}:${row.textContent}` === chipText.current) return;
    chipText.current = `${chipParts.style}:${folded}:${row.textContent}`;
    fitChips(row);
  });
  useEffect(() => {
    const row = chipRow.current;
    if (!row) return;
    let width = row.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (row.clientWidth === width) return;
      width = row.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitChips(row));
    });
    observer.observe(row);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
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
    const reviewer = participants.find((p) => p.id === id);
    if (reviewer) setText((draft) => reviewDraft(mentionFor(reviewer), draft));
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
      // Files (not folders) dropped from this Mac come back in the Work bar's Files list.
      if (!path.endsWith("/")) recentFiles.remember(path);
    }
  };
  /** Attach a file on this Mac by its path: Files' list and Browse all. A server thread gets a copy. */
  const attachPath = (path: string) => {
    const name = path.replace(/\/+$/, "").split("/").pop() || path;
    track(name, undefined, () => backend.copyAttachment(pane.id, path));
    recentFiles.remember(path);
    input.current?.focus();
  };
  const recent = useSyncExternalStore(recentFiles.subscribe, recentFiles.get);
  /** The opening question's project name opens the picker too. */
  const [askPicker, setAskPicker] = useState(0);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let live = true;
    backend.onFileDrop((paths, x, y) => attachDropped.current(paths, x, y)).then((stop) => (live ? (unlisten = stop) : stop()));
    return () => { live = false; unlisten?.(); };
  }, [backend]);

  // Artifacts and Changes sit on the pane's top line, in the slot App leaves for them.
  // A host that names its own slot (a pop-out's top bar) skips the lookup and the refit.
  const [ownSlot, setOwnSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (countsSlot !== undefined) return;
    setOwnSlot(root.current?.closest(".pane")?.querySelector<HTMLElement>(".pane-head .pane-counts") ?? null);
  }, [countsSlot]);
  const headSlot = countsSlot !== undefined ? countsSlot : ownSlot;
  // The top line refits when the pane resizes or anything on it changes: counts, status words, the server chip.
  useEffect(() => {
    if (countsSlot !== undefined) return;
    const head = headSlot?.closest<HTMLElement>(".pane-head");
    if (!head) return;
    fitHead(head);
    const resized = new ResizeObserver(() => fitHead(head));
    resized.observe(head);
    // Only text and children: fitting sets an attribute, which must not trigger another fit.
    const changed = new MutationObserver(() => fitHead(head));
    changed.observe(head, { childList: true, characterData: true, subtree: true });
    return () => { resized.disconnect(); changed.disconnect(); };
  }, [headSlot, countsSlot]);

  const [serverLists, setServerLists] = useState<Record<string, ToolServer[]>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [serverTargets, setServerTargets] = useState<string[]>([]);
  useEffect(() => {
    if (!ready || !participants.length) return;
    let live = true;
    // Ask about the message as it will be sent, with a quote's leading handle.
    const outgoing = replies.length ? replyText(text, replies, participants) : text;
    const sticky = stickyFor(outgoing, queued);
    if (sticky) { setServerTargets(sticky); return; }
    // A slower answer for older text is ignored once the text has changed.
    backend.roomTargets(pane.id, outgoing).then(ids => { if (live) setServerTargets(ids); }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, pane.id, text, replies, ready, participants, optionsSaved, options.policy, queued]);
  /** Who gets the message as it stands, for the placeholder. */
  const recipient = recipientName({
    targets: serverTargets,
    roster: participants.map((p) => ({ id: p.id, name: p.display_name })),
    policy: options.policy,
  });
  const copy = composerCopy(busy, participants.length === 0, { quoting: replies.length > 0, to: recipient, tldr, plan: planOn });
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
  // Tools in the Work bar: every bot's servers, apps and plugins here, once each.
  const workTools: WorkTool[] = [];
  for (const p of participants) for (const server of serverLists[p.id] ?? []) {
    if (!workTools.some((t) => t.token === server.token)) workTools.push({ token: server.token, label: server.label, bot: p.display_name });
  }
  const useTool = (token: string) => {
    setText((current) => appendToolToken(current, token));
    requestAnimationFrame(() => { const end = input.current?.value.length ?? 0; input.current?.focus(); input.current?.setSelectionRange(end, end); });
  };
  const requestedServers = parseServerRequests(text).map(s => s.name);
  const unknownServers = serverTargets.length && serverTargets.every(id => serverLists[id] !== undefined)
    ? resolveServerRequests(requestedServers, serverTargets.flatMap(id => serverLists[id])).unknown : [];
  // Picture and video bots: each provider's model list, so the composer knows what a message will cost.
  const [providerModels, setProviderModels] = useState<Record<string, ApiModel[]>>({});
  const providerSources = participants.flatMap(p => p.backend.kind === "open_ai_compatible" ? [p.backend] : []);
  const providerSig = [...new Set(providerSources.map(b => sourceKey(b.base_url, b.api_key_env)))].join("\n");
  useEffect(() => {
    let live = true;
    for (const b of providerSources) {
      const key = sourceKey(b.base_url, b.api_key_env);
      backend.apiModels(b.base_url, b.api_key_env).then(list => { if (live) setProviderModels(lists => ({ ...lists, [key]: list })); }).catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, providerSig]);
  const picturesAttached = sendable.some(a => isImage(a.path!));
  const mediaSends = mediaSendsFor(serverTargets, participants, providerModels, picturesAttached);
  const mediaSig = JSON.stringify(mediaSends);
  const [pricing, setPricing] = useState<{ sig: string; usd: number | null } | null>(null);
  useEffect(() => {
    if (!mediaSends.length) return;
    let live = true;
    const timer = setTimeout(() => {
      void priceSend(mediaSends, backend).then(({ usd }) => { if (live) setPricing({ sig: mediaSig, usd }); }).catch(() => {});
    }, 300);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, mediaSig]);
  const pricePill = pricing?.sig === mediaSig && mediaSends.length && pricing.usd != null && pricing.usd > 0 && (text.trim() || sendable.length) ? priceLabel(pricing.usd) : null;

  /** Answer the question on the form, or skip it with `null`. */
  const answerQuestion = (request: string, answers: string[][] | null) => {
    const by = form.kind === "question" ? form.ask.id : null;
    answeredHere.current = request;
    backend.roomAnswer(pane.id, request, answers).then(
      () => { if (answers && by) setAnswered((all) => ({ ...all, [by]: answerText(answers) })); },
      (error) => flashForm(String(error).replace(/^Error: /, "")),
    );
  };
  /** Send a next step to the bot that suggested it. */
  const sendStep = (step: NextStep, by: string) => {
    dismissSteps(pane.id);
    stuck.current = true;
    void turnQueue.sendTo(step.prompt, [by]).catch((error) => notify(String(error), "error"));
  };
  /** A key in the composer that the form takes. True when it was handled. */
  const formKeys = (key: string) => {
    const act = formKey(key, text === "", form, highlighted);
    if (act.act === "none") return false;
    if (act.act === "move") setHighlighted(act.index);
    else if (act.act === "dismiss") dismissSteps(pane.id);
    else if (act.act === "collapse") setFormFolded(true);
    else if (act.act === "fill" && form.kind === "steps") setText(form.offer.steps[act.index].prompt);
    else if (act.act === "pick" && form.kind === "steps") sendStep(form.offer.steps[act.index], form.offer.by);
    else if (act.act === "pick" && form.kind === "question") {
      const [q] = form.ask.questions;
      // A single plain question is answered from the keyboard; anything
      // more is answered on the form itself.
      if (form.ask.questions.length === 1 && q && !q.multi_select && q.options[act.index]) answerQuestion(form.ask.request, [[q.options[act.index].label]]);
      else setHighlighted(act.index);
    }
    return true;
  };
  const send = async (steer = false) => {
    if (!ready) return;
    panelDismissed.current = false;
    const targetIds = stickyFor(text, turnQueue.items) ?? await backend.roomTargets(pane.id, text).catch(() => [] as string[]);
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
    // A picture or video bot needs its picture. Each picture or video is asked for on the bot's own card, before it is made.
    const sends = mediaSendsFor(targetIds, participants, providerModels, sendable.some(a => isImage(a.path!)));
    if (sends.length) {
      const { missing } = await priceSend(sends, backend);
      if (missing) { notify(`${missing.name} needs a picture: attach one to animate.`, "error"); return; }
    }
    // Sending takes you to the bottom, where your message and the replies land,
    // and clears "New since you looked".
    stuck.current = true;
    setUnread(0);
    setDividerAt(null);
    // Mods allowed to see the session may rewrite the prompt or refuse it.
    const hooked = parsed.text ? await modHost.promptSubmit(pane.id, parsed.text) : { text: parsed.text };
    if (hooked.deny) { notify(hooked.deny, "error"); return; }
    const message = withTldr(withAttachments(hooked.text && replyText(postable(hooked.text), replies.length ? replies : null, participants), sendable.map((a) => a.path!)), tldr);
    if (!backend.host || hostCanMutate(backend.host.connection.get().status)) { /* rechecked by queue acceptance */ } else return;
    if (tldr) wiggle(field.current);
    // ⌘↵ queues it, then steers it from the queue, so a cancelled prompt leaves it queued.
    setSendingFirst(true);
    void turnQueue.send(message).then(id => {
      setText(current => current === text ? "" : current); setReplies([]);
      attached.forEach(a => a.preview && URL.revokeObjectURL(a.preview));
      setAttached(current => current.filter(a => !attached.includes(a)));
      const item = turnQueue.items.find(queuedItem => queuedItem.id === id);
      if (steer && item) askToSteer(item);
      // A message queued while the person holds the phone tells waiting bots to end their turn.
      // Only a message still in the queue counts: one to an idle bot was posted at once.
      if (item) void backend.phone?.chatQueued(pane.id).catch(() => {});
    }).catch(error => { setSendingFirst(false); notify(String(error), "error"); });
  };

  /** Put an example in the composer without sending it. */
  const insertExample = (example: string) => {
    const next = text.trim() ? `${text.trimEnd()} ${example}` : example;
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.length, next.length); });
  };
  const mention = (bot: ParticipantConfig) => {
    const handle = mentionFor(bot);
    setText((t) => (t && !t.endsWith(" ") ? `${t} @${handle} ` : `${t}@${handle} `));
    input.current?.focus();
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const keyName = (adding || quickAdd) && takesKey(draft.preset) ? keyNameOf(draft) : "";
  useEffect(() => {
    setKeyState(null);
    if (!keyName || backend.demo) return;
    let current = true;
    const timer = setTimeout(() => backend.apiKeyStatus([keyName]).then(([state]) => { if (current) setKeyState(state ?? null); }, () => {}), 250);
    return () => { current = false; clearTimeout(timer); };
  }, [backend, keyName]);

  const preset = PRESETS.find((p) => p.key === draft.preset)!;

  // Ask the tool for its own model list the first time its preset is shown.
  const tool = preset.agent?.tool;
  const speedAvailable = supportsSpeed(tool
    ? { kind: "agent", tool, model: draft.model }
    : preset.api
      ? { kind: "open_ai_compatible", base_url: draft.baseUrl, model: draft.model, api_key_env: null }
      : { kind: "scripted", lines: [] });
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
      // Some servers only list models for a key, so save a typed one first.
      const keyed = await withKey({ ...draft, baseUrl, keyEnv });
      const found = await backend.apiModels(baseUrl.trim(), keyed.keyEnv.trim() || (keyState && keyState !== "missing" ? keyNameOf(keyed) : "") || null);
      setApiModels(found);
      setModelNote(found.length ? `Found ${found.length} model${found.length === 1 ? "" : "s"}. Pick one or type a name.` : "The server answered but listed no models.");
      if (found.length) setDraft((d) => (d.model ? d : { ...d, model: found[0].id, effort: found[0].efforts ? defaultEffortFor(found[0].efforts) : d.effort }));
    } catch (error) {
      setApiModels([]);
      setModelNote(/\b401\b/.test(String(error))
        ? "The server wants an API key before it lists models. Paste one under API key, then press List models."
        : `Could not list models: ${String(error)}. You can still type a model name.`);
    }
  };

  const choosePreset = (key: PresetKey) => {
    const next = PRESETS.find((p) => p.key === key)!;
    // Only tools that enforce access themselves can stop and ask.
    setDraft((d) => ({ ...emptyDraft(key), appearance: d.appearance, name: d.name, persona: d.persona, access: d.access === "ask" && !asksFirst(next) ? "read" : d.access }));
    // Model and effort names differ between backends, so they start empty.
    setApiModels([]);
    setModelNote("");
    setFormError("");
    if (next.api?.autoLoad) loadModels(next.api.baseUrl, next.api.key ? keyNameFor(next.api.baseUrl) : "");
  };

  const agentGroups = preset.agent ? modelGroups(preset.agent.tool, reported[preset.agent.tool] ?? [], preset.label) : [];
  const typedBefore = preset.agent ? (rememberedModels()[preset.key] ?? []).filter((m) => !findModel(agentGroups, m)) : [];
  const modelChoices: PickerGroup[] = [
    { label: "Typed before", options: typedBefore.map((m) => ({ value: m, text: m })) },
    ...agentGroups.map((g) => ({ label: g.label, options: g.models.map((m) => ({ value: m.id, text: m.label ? `${m.id}  ·  ${m.label}` : m.id })) })),
  ];
  const apiGroups = preset.api ? apiModelGroups(apiModels) : [];
  const chosenModel = findModel(preset.agent ? agentGroups : apiGroups, draft.model);
  const efforts = effortsFor(preset.efforts, preset.agent ? agentGroups : apiGroups, draft.model);
  const chosenApiModel = preset.api ? apiModels.find((m) => m.id === draft.model.trim()) : undefined;

  /** Pick a provider model. New picks start on Medium, or the closest level the model takes. */
  const setApiModel = (model: string) =>
    setDraft((d) => {
      const known = apiModels.find((m) => m.id === model.trim())?.efforts;
      if (!known) return { ...d, model };
      return { ...d, model, effort: d.effort && known.includes(d.effort) ? d.effort : defaultEffortFor(known) };
    });

  /** Pick a model, dropping an effort level the new model does not accept. */
  const setAgentModel = (model: string) =>
    setDraft((d) => {
      const known = findModel(agentGroups, model)?.efforts;
      return { ...d, model, effort: known && !known.includes(d.effort) ? "" : d.effort };
    });

  // For the sidebar: whether a bot has replied (Copy last reply) and when the newest message came (Recents).
  const transcriptFacts = useMemo(() => {
    const messages = messagesOf(entries);
    return { hasReply: messages.some((m) => m.speaker.kind === "bot"), lastAt: messages.reduce((latest, m) => Math.max(latest, m.at ?? 0), 0), count: messages.length };
  }, [entries]);
  const started = threadStarted(transcriptFacts.count, pane.fork?.at ?? 0, sendingFirst);
  // A fork's line sits after the history it copied: where it came from, and that nothing ran yet.
  const copiedUpTo = pane.fork?.at ?? 0;
  const forkAfter = useMemo(() => (copiedUpTo > 0 ? messagesOf(entries)[copiedUpTo - 1]?.seq ?? null : null), [entries, copiedUpTo]);
  const forkLine = pane.fork && (copiedUpTo === 0 || forkAfter !== null) ? (
    <div key="fork-line" className="fork-line" role="note">
      {forkIcon}
      <span>Forked from “{pane.fork.title}” on {pane.fork.host}.{started ? "" : " The history is copied; nothing runs until you send."}{pane.fork.crossed ? ` Attachments in it stay on ${pane.fork.host}.` : ""}</span>
    </div>
  ) : null;
  // The pane head's words (see headLine), and who is replying or stopped on a card, for App.
  const headBots: BotProgress[] = participants
    .filter((p) => working[p.id] && !asks[p.id]?.length)
    .map((p) => ({
      name: p.display_name,
      doing: doingNow(working[p.id]),
      startedAt: working[p.id].startedAt,
      heardAt: isCommandLine(p.backend) ? heard.current.get(p.id) ?? working[p.id].startedAt : null,
    }));
  const status: ThreadStatus = { ...threadStatusOf(participants, Object.keys(working), Object.keys(asks).filter((id) => asks[id].length > 0)), text: headLine(participants.length, headBots, now), hasReply: transcriptFacts.hasReply, lastAt: transcriptFacts.lastAt, started };
  const statusKey = JSON.stringify(status);
  useEffect(() => { if (!profileMode) onStatus?.(pane.id, status); }, [statusKey]);
  // The title bar's + New agent opens the form here.
  useEffect(() => { if (profileMode && addRequest) openNewForm(); }, [addRequest]);

  // In the quick add menu the name follows the model until the person types one.
  useEffect(() => {
    if (!quickAdd || nameTouched.current) return;
    const tool = preset.agent?.tool ?? preset.key;
    const name = uniqueName(nameForModel(tool, preset.label, draft.model), [...participants.map(mentionFor), ...queuedBots.map((d) => slug(d.name))], slug);
    if (name !== draft.name) set("name", name);
  }, [quickAdd, draft.preset, draft.model, participants, queuedBots]);

  // Each provider balance is read on open and again shortly after a bot on it replies.
  const accounts = new Map(participants.flatMap((p) => { const a = accountOf(p); return a ? [[a.key, a] as const] : []; }));
  const accountKeys = [...accounts.keys()].sort().join("\n");
  const apiTurns = participants.reduce((n, p) => (accountOf(p) ? n + (used[p.id]?.turns ?? 0) : n), 0);
  useEffect(() => {
    if (!accountKeys) return;
    let active = true;
    const timer = setTimeout(() => {
      for (const a of accounts.values()) backend.apiBalance(a.baseUrl, a.keyEnv).then((usd) => { if (active && usd != null) setBalances((b) => ({ ...b, [a.key]: usd })); }).catch(() => {});
    }, apiTurns ? 1500 : 0);
    return () => { active = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, accountKeys, apiTurns]);
  /** The balance row for a custom provider bot: what is left on the account and what this chat cost. */
  const moneyRow = (p: ParticipantConfig | undefined) => {
    const account = accountOf(p);
    if (!account || !p) return undefined;
    const left = balances[account.key];
    const spent = spendLine(used[p.id], dollars);
    const parts = [left != null ? `${dollars(left)} left` : "", spent ? `this chat ${spent}` : ""].filter(Boolean);
    return parts.length ? <span key="money" className="bot-meter bot-meter-money" title={left != null ? "Prepaid balance on this provider account" : "What this chat has cost on this provider"}>{left != null ? "bal" : "cost"}<span>{parts.join(" · ")}</span></span> : null;
  };

  // Battery levels: context is each agent's own, the plan its provider's.
  const configOf = (id: string) => participants.find((p) => p.id === id);
  /** Picture and video bots keep no conversation, so a context reading from an earlier text model no longer applies. */
  const mediaOf = (p: ParticipantConfig | undefined) => {
    const b = p?.backend;
    return b?.kind === "open_ai_compatible" ? mediaKind(providerModels[sourceKey(b.base_url, b.api_key_env)]?.find((m) => m.id === b.model)) : null;
  };
  const makesMedia = (p: ParticipantConfig | undefined) => Boolean(mediaOf(p));
  /** Stopping only stops Deck waiting: a picture or video the provider already started may still be billed. */
  const chargeWarning = (ids: string[]) => {
    const kinds = new Set(ids.map((id) => mediaOf(configOf(id))).filter(Boolean));
    if (!kinds.size) return null;
    const p = configOf(ids.find((id) => mediaOf(configOf(id)))!);
    const who = p?.backend.kind === "open_ai_compatible" && /venice\.ai/i.test(p.backend.base_url) ? "Venice" : "The provider";
    return `${who} may still charge for the ${kinds.has("video") ? "video" : "picture"}, since it had already started making it.`;
  };
  const stopBots = (id?: string) => {
    const warning = chargeWarning(id ? [id] : Object.keys(working));
    void turnQueue.halt(id);
    if (warning) notify(`Stopped. ${warning}`, "info");
  };
  const levelsFor = (id: string): Levels => {
    const provider = planProvider(configOf(id));
    return { context: makesMedia(configOf(id)) ? null : contextLevel(contextFill[id]), plan: provider ? planLevel(plans[provider]?.windows, Date.now() / 1000) : null };
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
  const usageCard = (p: ParticipantConfig, at?: { left: number; bottom: number } | null) => {
    const fill = contextFill[p.id];
    const provider = planProvider(p);
    const windows = provider ? plans[provider]?.windows : undefined;
    const plan = windows ? planLine(windows, new Date()) : null;
    const reports = (p.backend.kind === "agent" && p.backend.tool !== "grok") || p.backend.kind === "open_ai_compatible";
    const account = accountOf(p);
    const left = account ? balances[account.key] : undefined;
    const spent = spendLine(used[p.id], dollars);
    const sharing = provider ? participants.filter((other) => planProvider(other) === provider).length : 0;
    return (
      <div ref={at ? cardBox : undefined} className={at ? "usage-card above" : "usage-card"} style={at ? { left: at.left, bottom: at.bottom } : undefined} role="group" aria-label={`Usage for ${p.display_name}`}>
        {!makesMedia(p) && <div className="usage-row">
          <span className="usage-label">Context</span>
          <span className={isLow(contextLevel(fill)) ? "usage-low" : undefined}>{fill ? contextLine(fill) : reports ? "Not reported yet. The next reply says." : "Not reported by this provider"}</span>
        </div>}
        {account ? <>
          <div className="usage-row">
            <span className="usage-label">Balance</span>
            <span>{left != null ? `${dollars(left)} left on this account` : "Not offered by this provider"}</span>
          </div>
          {!!spent && <div className="usage-row">
            <span className="usage-label">Cost</span>
            <span>{spent} in this chat</span>
          </div>}
        </> : <div className="usage-row">
          <span className="usage-label">Plan</span>
          <span className={isLow(provider ? planLevel(windows, Date.now() / 1000) : null) ? "usage-low" : undefined}>
            {plan ?? (!provider ? "Not reported by this provider" : provider === "claude_code" ? "Known after a Claude Code reply" : "Not reported yet")}
          </span>
        </div>}
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
    : enforcesAccess(preset)
      ? "Enforced by Apex Deck, which runs this bot's tools: files, commands, web pages and your MCP servers."
      : "Stated to the model as an instruction. Not enforced.";

  /** Open the full form for a new bot or agent. */
  function openNewForm() {
    details?.show("form");
    if (preset.api?.autoLoad && apiModels.length === 0) loadModels(draft.baseUrl, draft.keyEnv);
    setDraft((d) => {
      const base = providerEnabled(d.preset, disabledProviders) ? d : emptyDraft(firstPreset, defaults.current.newBotAccess);
      // A new agent picks its pattern and colour as soon as the form opens, so
      // the preview is the look Save will keep rather than a second draw at save.
      return base.appearance ? base : { ...base, appearance: createAppearance([...identities.current.values()]) };
    });
    setEditing(null);
    setAdding(true);
  }
  // Any other path that opens the new-agent form gets a picker too.
  useEffect(() => {
    if (adding && !editing && !draft.appearance) setDraft((d) => (d.appearance ? d : { ...d, appearance: createAppearance([...identities.current.values()]) }));
  }, [adding, editing, draft.appearance]);
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
  // Editing previews the saved look; a new agent previews what openNewForm seeded.
  const formAppearance = draft.appearance ?? (editing ? appearance(editing) : undefined);
  const edited = editing ? participants.find((p) => p.id === editing) : undefined;
  const modelForm = (adding && (
        <form
          className="add-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveParticipant();
          }}
        >
          <div className="wide form-head">
            <button type="button" className="ghost form-back" onClick={() => closeForm(draft.preset)}>← Back</button>
            <p className="form-title">{!editing ? "New agent" : edited ? `Change settings for @${mentionFor(edited)}` : "Change settings"}</p>
          </div>
          <label>
            Name
            <input name="name" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Opus" autoFocus />
            {draft.name && <span className="hint">{mentionable(draft.name) ? `Mention as @${slug(draft.name)}` : "A name needs a letter or a number."}</span>}
          </label>
          {formAppearance && <div className="appearance-controls">
            <Avatar seed={formAppearance.seed} color={formAppearance.color} />
            <HexColorPicker
              label="Color"
              value={formAppearance.color}
              presets={AGENT_COLORS}
              onChange={(color) => set("appearance", { ...formAppearance, color })}
            />
            <button type="button" className="ghost" onClick={() => set("appearance", { ...createAppearance([...identities.current.values()]), color: formAppearance.color })}>New pattern</button>
          </div>}
          <div className="wide provider-field">
            <span className="field-title" id={`provider-title-${pane.id}`}>Connect through</span>
            <ProviderGrid
              value={draft.preset}
              onPick={(key) => choosePreset(key as PresetKey)}
              options={PRESETS.filter((p) => providerEnabled(p.key, disabledProviders) || (editing && p.key === draft.preset)).map((p) => ({
                key: p.key,
                label: p.label.replace(/ \(.*\)$/, ""),
                hint: p.agent ? { claude_code: "Anthropic", codex: "OpenAI", gemini: "Google" }[p.agent.tool as "claude_code" | "codex" | "gemini"] ?? "xAI" : p.key === "deepseek" ? "DeepSeek API" : p.key === "ollama" ? "Runs on this machine" : p.key === "api" ? "Any OpenAI-style server" : p.key === "command" ? "Your own script" : "Canned replies for testing",
                installed: installed(p),
                enabled: true,
              }))}
            />
          </div>
          {preset.agent && (
            <div className="wide model-field">
              <span className="field-title">Model</span>
              <ModelSearchList
                key={`model:${draft.preset}:${editing ?? "new"}`}
                value={draft.model}
                onChange={setAgentModel}
                groups={modelChoices}
                emptyLabel={`Default (whatever ${preset.label} is set to)`}
                modelNote={`${preset.agent.modelNote}${chosenModel?.note ? ` ${chosenModel.note}` : ""}`}
              />
            </div>
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
                  <input name="model" list={`models-${pane.id}`} value={draft.model} onChange={(e) => setApiModel(e.target.value)} placeholder="e.g. llama3" />
                  <button type="button" className="ghost" onClick={() => loadModels(draft.baseUrl, draft.keyEnv)}>
                    List models
                  </button>
                </span>
                <datalist id={`models-${pane.id}`}>
                  {apiGroups.flatMap((g) => g.models).map((m) => (
                    <option key={m.id} value={m.id}>{m.label ?? undefined}</option>
                  ))}
                </datalist>
                {modelNote && <span className="hint">{modelNote}</span>}
              </label>
              {preset.api.key && (
                <div className="key-field">
                <label>
                  API key
                  <input name="api-key" type="password" autoComplete="off" spellCheck={false} value={draft.apiKey ?? ""} onChange={(e) => set("apiKey", e.target.value)} placeholder={keyState === "saved" ? "Saved. Paste a new key to replace it" : keyState === "environment" ? "Found in the environment. Paste one to save it" : "Paste your API key"} />
                  <span className="hint">{keyNote(keyState, keyNameOf(draft))}</span>
                </label>
                <details className="key-name">
                  <summary>Key name</summary>
                  <div className="key-name-body">
                  <input name="key-env" aria-label="Key name" value={draft.keyEnv} onChange={(e) => set("keyEnv", e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} placeholder={keyNameOf({ ...draft, keyEnv: "" }) || "e.g. MY_PROVIDER_API_KEY"} />
                  <span className="hint">Bots that share a name share one key. An environment variable with this name also works.</span>
                  </div>
                </details>
                </div>
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
            <div className="wide effort-field">
              <span className="field-title">Reasoning effort</span>
              {efforts.length > 0 ? (
                <Segmented
                  label="Reasoning effort"
                  name="effort"
                  value={draft.effort}
                  onChange={(level) => set("effort", level.trim().toLowerCase())}
                  options={[{ value: "", text: chosenApiModel?.default_effort ? `Default (${effortLabel(chosenApiModel.default_effort)})` : "Default" }, ...efforts.map((level) => ({ value: level, text: effortLabel(level) }))]}
                />
              ) : (
                <span className="hint">Not available for this model — the provider picks its own effort.</span>
              )}
              <span className="hint">
                {efforts.length > 0
                  ? chosenModel
                    ? "These are the levels this model accepts. Higher levels think longer and cost more."
                    : "Higher levels think longer and cost more. Not every model accepts every level."
                  : "This model has no effort setting."}
              </span>
            </div>
          )}
          {speedAvailable && (
            <div className="wide effort-field">
              <span className="field-title">Speed</span>
              <Segmented
                label="Speed"
                name="speed"
                value={draft.speed ?? ""}
                onChange={(speed) => set("speed", speed)}
                options={SPEED_OPTIONS}
              />
              <span className="hint">{speedHint(tool)}</span>
            </div>
          )}
          {draft.preset !== "scripted" && (
            <div className="wide access-field">
              <span className="field-title">Access</span>
              <Segmented
                label="Access"
                name="access"
                value={draft.access}
                onChange={(v) => set("access", v as Access)}
                options={[
                  { value: "read", text: "Read only" },
                  ...(asksFirst(preset) ? [{ value: "ask", text: "Ask first" } as const] : []),
                  { value: "edits", text: "Can edit files" },
                  { value: "full", text: "Full access" },
                ]}
              />
              <span className="hint">{accessNote}</span>
            </div>
          )}
          <PersonaDraft
            key={`persona:${editing ?? "new"}`}
            writers={personaWriters(
              PRESETS.flatMap((p) => p.agent ? [{ key: p.key, label: p.label.replace(/ \(.*\)$/, ""), tool: p.agent.tool, installed: installed(p) }] : []),
              profiles, disabledProviders)}
            preset={draft.preset}
            taken={[...new Set([...profiles, ...participants].filter((p) => p.id !== editing).map((p) => p.display_name))]}
            form={{ name: draft.name, persona: draft.persona }}
            onApply={(next) => setDraft((d) => ({ ...d, name: next.name, persona: next.persona }))}
            onIdea={(persona) => setDraft((d) => ({ ...d, persona }))}
            write={(writer, idea, taken) => backend.personaDraft(writer, idea, taken)}
          />
          {formError && <p className="form-error">{formError}</p>}
          <div className="form-foot">
            <button className="primary" type="submit">
              {editing ? "Save changes" : profileMode ? "Save agent" : "Add to chat"}
            </button>
            <button type="button" className="ghost" onClick={() => closeForm(draft.preset)}>
              Cancel
            </button>
          </div>
        </form>
      ));
  const freezeDraft = async (): Promise<boolean> => {
    let ready: Draft;
    try {
      ready = await withKey(draft);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      return false;
    }
    const built = draftToConfig(ready);
    if (typeof built === "string") {
      setFormError(built);
      return false;
    }
    const taken = [...identities.current.values(), ...queuedBots.flatMap((d) => (d.appearance ? [d.appearance] : []))];
    setQueuedBots((list) => [...list, { ...ready, apiKey: "", appearance: ready.appearance ?? createAppearance(taken) }]);
    setFormError("");
    return true;
  };

  const anotherBot = async () => {
    if (editorOpen && !(await freezeDraft())) return;
    setQuickPersonaId((id) => id + 1);
    nameTouched.current = false;
    setDraft((d) => emptyDraft(d.preset, d.access));
    setEditorOpen(true);
  };

  const openRow = async (index: number) => {
    const row = queuedBots[index];
    if (!row) return;
    if (editorOpen && !(await freezeDraft())) return;
    setQuickPersonaId((id) => id + 1);
    setQueuedBots((list) => list.filter((d) => d !== row));
    nameTouched.current = true;
    setDraft(row);
    setEditorOpen(true);
    setFormError("");
  };

  const removeRow = (index: number) => setQueuedBots((list) => list.filter((_, i) => i !== index));

  const togglePicked = (id: string) => setPickedAgents((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const savedToAdd = availableProfiles.filter((p) => pickedAgents.has(p.id) && !participants.some((own) => own.id === p.id));
  const batchTotal = savedToAdd.length + queuedBots.length + (editorOpen ? 1 : 0);
  /** Names of the new bots in the batch: queued rows, then the open editor. */
  const newNames = [...queuedBots.map((d) => d.name), ...(editorOpen ? [draft.name] : [])];
  const submitBatch = async (): Promise<boolean> => {
    setFormError("");
    if (editorOpen && !providerEnabled(draft.preset, disabledProviders)) {
      setFormError("This provider is disabled. Enable it in Providers to add a bot.");
      return false;
    }
    const saved = savedToAdd;
    let rows = queuedBots;
    const offRow = rows.find((d) => !providerEnabled(d.preset, disabledProviders));
    if (offRow) {
      setFormError(`${offRow.name.trim() || "New bot"}: this provider is disabled. Enable it in Providers or remove the bot.`);
      return false;
    }
    if (editorOpen) {
      let ready: Draft;
      try {
        ready = await withKey(draft);
      } catch (error) {
        setFormError(error instanceof Error ? error.message : String(error));
        return false;
      }
      rows = [...rows, { ...ready, apiKey: "" }];
    }
    const taken = [...identities.current.values()];
    const fresh: ParticipantConfig[] = [];
    for (let i = 0; i < rows.length; i++) {
      const built = draftToConfig(rows[i]);
      if (typeof built === "string") {
        setFormError(`${rows[i].name.trim() || "New bot"}: ${built}`);
        return false;
      }
      const look = built.appearance ?? createAppearance(taken);
      taken.push(look);
      fresh.push({ ...built, appearance: look });
    }
    const items = [...saved, ...fresh];
    if (items.length === 0) return false;
    const checked = checkBatch(items, { others: participants, agents: profiles });
    if ("error" in checked) {
      if (checked.index < saved.length) {
        notify(checked.error, "error");
      } else {
        setFormError(checked.error);
      }
      return false;
    }
    const result = await addInOrder(checked.ok, (config) => backend.roomAddParticipant(pane.id, config));
    setParticipants((list) => [...list, ...result.added.filter((c) => !list.some((p) => p.id === c.id))]);
    for (const c of result.added) {
      if (c.backend.kind === "agent" && c.backend.model) {
        rememberModel(c.backend.tool, c.backend.model);
      }
    }
    if (result.failed) {
      const split = splitAdded(result.added.length, saved.length);
      setPickedAgents((old) => {
        const next = new Set(old);
        for (const c of result.added) next.delete(c.id);
        return next;
      });
      setQueuedBots(rows.slice(split.rows));
      setEditorOpen(false);
      setFormError(`Added ${result.added.length}. Could not add ${checked.ok[result.failed.index].display_name}: ${result.failed.error}`);
      return false;
    }
    return true;
  };
  /** Saved agents not already in this thread, offered as tiles in the add menu. */
  const pickableAgents = availableProfiles.filter((p) => !participants.some((own) => own.id === p.id));
  const openQuickAdd = (where: "dock" | "details", opener?: HTMLElement) => {
    if (quickAdd === where) return setQuickAdd(null);
    quickAddOpener.current = opener ?? null;
    nameTouched.current = false;
    setPickedAgents(new Set());
    setQueuedBots([]);
    setQuickPersonaId((id) => id + 1);
    // Saved agents to pick: start with no new bot. None: start with one open.
    setEditorOpen(pickableAgents.length === 0);
    setEditing(null);
    setAdding(false);
    setFormError("");
    const start = providerEnabled(draft.preset, disabledProviders) && installed(preset) ? draft.preset : firstPreset;
    setDraft({ ...emptyDraft(start), access: draft.access });
    const startPreset = PRESETS.find((p) => p.key === start);
    if (startPreset?.api?.autoLoad) loadModels(startPreset.api.baseUrl, startPreset.api.key ? keyNameFor(startPreset.api.baseUrl) : "");
    setQuickAdd(where);
  };
  /** Up to three tools for the quick menu: installed coding agents, then local models. */
  const quickTools = availablePresets.filter((p) => (p.agent && installed(p)) || p.key === "ollama").slice(0, 3);
  const quickAddMenu = (
    <form ref={quickAddForm} className="quick-add" role="dialog" aria-label="Add a bot" onSubmit={async (e) => { e.preventDefault(); if (await submitBatch()) { closeForm(draft.preset); setQuickAdd(null); } }}>
      <header className="quick-add-head">
        <h3>Who's in this thread?</h3>
        <p>Pick saved agents, or set up new ones below.</p>
        <button type="button" className="quick-add-close" aria-label="Close menu" onClick={() => setQuickAdd(null)}>×</button>
      </header>
      <div className="quick-add-scroll">
      {pickableAgents.length > 0 && <>
        <div className="quick-add-section"><span className="quick-add-label">Saved agents</span><span className="quick-add-count">{savedToAdd.length} picked</span></div>
        <div className="quick-add-saved">
          {pickableAgents.map((p) => {
            const look = p.appearance ?? legacyAppearance(p.id);
            return (
              <AgentTile key={p.id} name={p.display_name} seed={look.seed} color={look.color} picked={pickedAgents.has(p.id)} onToggle={() => togglePicked(p.id)} />
            );
          })}
        </div>
      </>}
      <div className="quick-add-section"><span className="quick-add-label">New bots</span><span className="quick-add-count">Up to {MAX_NEW_BOTS}</span></div>
      {queuedBots.map((d, i) => (
        <div className="quick-add-row" key={`${d.name}-${i}`}>
          <button type="button" className="quick-add-row-open" title="Edit this bot" onClick={() => openRow(i)}>
            <span className="quick-add-face" aria-hidden="true">{(d.name.trim()[0] ?? "?").toUpperCase()}</span>
            <span className="quick-add-row-text">{PRESETS.find((p) => p.key === d.preset)?.label.replace(/\s*\(.*\)$/, "") ?? d.preset} · {d.name} · {d.effort ? effortLabel(d.effort) : "Default"} · {accessLabel(d.access)}</span>
          </button>
          <button type="button" className="quick-add-row-x" aria-label={`Remove ${d.name}`} onClick={() => removeRow(i)}>×</button>
        </div>
      ))}
      {editorOpen && (<div className="quick-add-editor">
        <button type="button" className="quick-add-row-x quick-add-editor-x" aria-label="Remove this bot" onClick={() => { setEditorOpen(false); setFormError(""); }}>×</button>
      <div className="quick-add-tools" role="radiogroup" aria-label="Tool">
        {quickTools.map((p) => (
          <button type="button" role="radio" aria-checked={draft.preset === p.key} key={p.key} className={draft.preset === p.key ? "qa-tool on" : "qa-tool"} title={p.label} onClick={() => choosePreset(p.key)}>
            <ProviderLogo preset={p.key} label={`${p.label} logo`} />
            <span>{p.label.replace(/\s*\(.*\)$/, "")}</span>
          </button>
        ))}
        <button type="button" className="qa-more" title="Open the full new-agent form" onClick={() => { setQuickAdd(null); openNewForm(); }}>More…</button>
      </div>
      <div className="quick-add-grid">
        <label>Model
          {preset.agent ? (
            <select name="quick-model" value={modelChoices.some((g) => g.options.some((o) => o.value === draft.model)) || draft.model === "" ? draft.model : "__custom__"} onChange={(e) => setAgentModel(e.target.value === "__custom__" ? draft.model : e.target.value)} title={draft.model || "Default"}>
              <option value="">Default</option>
              {draft.model !== "" && !modelChoices.some((g) => g.options.some((o) => o.value === draft.model)) && (
                <option value="__custom__">{draft.model} · typed</option>
              )}
              {modelChoices.filter((g) => g.options.length > 0).map((g) => (
                <optgroup key={g.label || "ungrouped"} label={g.label || undefined}>
                  {g.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.text} · {versionBadge(o.value) === "pins version" ? "pins" : "live"}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          ) : (
            <><input name="quick-model" list={`quick-models-${pane.id}`} value={draft.model} onChange={(e) => setApiModel(e.target.value)} placeholder="e.g. llama3" />
              <datalist id={`quick-models-${pane.id}`}>{apiGroups.flatMap((g) => g.models).map((m) => <option key={m.id} value={m.id}>{m.label ?? undefined}</option>)}</datalist></>
          )}
        </label>
        <label>Access
          <select name="quick-access" value={draft.access} onChange={(e) => set("access", e.target.value as Access)}>
            <option value="read">Read only</option>
            {asksFirst(preset) && <option value="ask">Ask first</option>}
            <option value="edits">Can edit files</option>
            <option value="full">Full access</option>
          </select>
        </label>
      </div>
      <div className="quick-add-grid">
        <label>Effort
          {efforts.length > 0 ? (
            <select name="quick-effort" value={draft.effort} onChange={(e) => set("effort", e.target.value)}>
              <option value="">
                {chosenApiModel?.default_effort
                  ? `Default (${effortLabel(chosenApiModel.default_effort)})`
                  : "Default"}
              </option>
              {efforts.map((level) => (
                <option key={level} value={level}>
                  {effortLabel(level)}
                </option>
              ))}
            </select>
          ) : (
            <span className="hint">This model has no effort setting.</span>
          )}
        </label>
        <label>Name
          <input name="quick-name" value={draft.name} onChange={(e) => { nameTouched.current = true; set("name", e.target.value); }} placeholder="e.g. Opus" />
          {draft.name && <span className="hint">{mentionable(draft.name) ? `Mention as @${slug(draft.name)}` : "A name needs a letter or a number."}</span>}
        </label>
      </div>
      {preset.api && (
        <>
          <label>Base URL
            <input name="quick-base-url" value={draft.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="e.g. https://api.example.com/v1" />
          </label>
          {preset.api.key && (
            <label>API key
              <input name="quick-api-key" type="password" autoComplete="off" spellCheck={false} value={draft.apiKey ?? ""} onChange={(e) => set("apiKey", e.target.value)} placeholder="Paste your API key" />
              <span className="hint">{keyNote(keyState, keyNameOf(draft))}</span>
            </label>
          )}
          <label>Key name
            <input name="quick-key-env" value={draft.keyEnv} onChange={(e) => set("keyEnv", e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} placeholder={keyNameOf({ ...draft, keyEnv: "" }) || "e.g. MY_PROVIDER_API_KEY"} />
          </label>
        </>
      )}
      <PersonaDraft
        key={`quick-persona:${quickPersonaId}`}
        writers={personaWriters(
          PRESETS.flatMap((p) => p.agent ? [{ key: p.key, label: p.label.replace(/ \(.*\)$/, ""), tool: p.agent.tool, installed: installed(p) }] : []),
          profiles, disabledProviders)}
        preset={draft.preset}
        taken={[...new Set([...profiles.map((p) => p.display_name), ...participants.map((p) => p.display_name), ...queuedBots.map((d) => d.name)])]}
        form={{ name: draft.name, persona: draft.persona }}
        onApply={(next) => { nameTouched.current = true; setDraft((d) => ({ ...d, name: next.name, persona: next.persona })); }}
        onIdea={(persona) => setDraft((d) => ({ ...d, persona }))}
        write={(writer, idea, taken) => backend.personaDraft(writer, idea, taken)}
      />
      </div>)}
        <button type="button" className="ghost quick-add-another" disabled={queuedBots.length + (editorOpen ? 1 : 0) >= MAX_NEW_BOTS} title={`Up to ${MAX_NEW_BOTS} new bots at a time`} onClick={anotherBot}>+ Another bot</button>
      </div>{/* end quick-add-scroll */}
      <div className="quick-add-foot">
        <span className="quick-add-faces" aria-hidden="true">
          {savedToAdd.map((p) => { const look = p.appearance ?? legacyAppearance(p.id); return <Avatar key={p.id} seed={look.seed} color={look.color} size="sm" />; })}
          {newNames.map((name, i) => <span key={`new-${i}`} className="quick-add-face">{(name.trim()[0] ?? "?").toUpperCase()}</span>)}
        </span>
        <span className="quick-add-say">{!formError && lineupText([...savedToAdd.map((p) => p.display_name), ...newNames])}<span role="status">{formError && <span className="form-error">{formError}</span>}</span></span>
        <button type="button" className="ghost" onClick={() => { setQuickAdd(null); openNewForm(); }}>More options</button>
        <button className="primary" type="submit" disabled={batchTotal === 0}>{batchLabel(batchTotal)}</button>
      </div>
    </form>
  );
  const quickAddButton = (where: "details", primary: boolean) => (
    <span className={`quick-add-wrap ${where}`}>
      <button className={primary ? "primary" : "ghost"} disabled={!ready || (availablePresets.length === 0 && availableProfiles.length === 0)} aria-haspopup="dialog" aria-expanded={quickAdd === where} onClick={(e) => openQuickAdd(where, e.currentTarget)}>+ Add bot</button>
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
          <div className="stepper-field" title="How many rounds of models answering each other are allowed after one of your messages. Step past 10 for unlimited (∞), which runs until you press Stop.">
            <span id={`rounds-${pane.id}`}>Model-to-model rounds</span>
            <span className="stepper">
              <button type="button" aria-label="Fewer rounds" disabled={!ready || busy || (options.max_bot_hops !== null && options.max_bot_hops <= 0)} onClick={() => changeOptions({ ...options, max_bot_hops: options.max_bot_hops === null ? 10 : Math.max(0, options.max_bot_hops - 1) })}>−</button>
              {options.max_bot_hops === null
                ? <output aria-labelledby={`rounds-${pane.id}`}>∞</output>
                : <input
                  type="number"
                  min={0}
                  max={10}
                  aria-labelledby={`rounds-${pane.id}`}
                  value={options.max_bot_hops}
                  disabled={!ready || busy}
                  onChange={(e) => changeOptions({ ...options, max_bot_hops: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
                />}
              <button type="button" aria-label="More rounds" disabled={!ready || busy || options.max_bot_hops === null} onClick={() => changeOptions({ ...options, max_bot_hops: options.max_bot_hops !== null && options.max_bot_hops >= 10 ? null : (options.max_bot_hops ?? 0) + 1 })}>+</button>
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
          <strong style={{ "--agent-color": color(p.id) } as CSSProperties}>{p.display_name}</strong>
          <span className="muted">{chipDescription(p, ALL_PARTS).replace(" · asks first", "")} · {accessLabel(p.access)}</span>
          {(levels.context !== null || levels.plan !== null) && <span className="bot-meters">{meter("ctx", levels.context)}{meter("plan", levels.plan)}</span>}
        </div>
        <span className="pane-menu-wrap">
          <button className="icon small" aria-label={`Actions for ${p.display_name}`} aria-haspopup="menu" aria-expanded={botMenu === p.id} onClick={() => setBotMenu(open => open === p.id ? null : p.id)}>⋯</button>
          {botMenu === p.id && <span className="pane-menu" role="menu">
            <button role="menuitem" disabled={busy} aria-label={`Change settings for ${p.display_name}`} onClick={() => { setBotMenu(null); details?.show("form"); startEditing(p); }}>Edit</button>
            <button role="menuitem" disabled={busy} aria-label={`Save ${p.display_name} to Agents`} onClick={() => { setBotMenu(null); const saved = savedToAgents(profiles, p); if ("error" in saved) notify(saved.error, "error"); else onProfilesChange(saved.profiles); }}>Save to Agents</button>
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
            <strong style={{ "--agent-color": color(rule.by) } as CSSProperties}>{names.get(rule.by) ?? rule.by}</strong>
            <span className={`allowed-what${rule.kind === "command" || rule.kind === "tool" ? " mono" : ""}`} title={rule.what}>{describeRule(rule)}</span>
            <span className="allowed-when">{allowedLine(rule, new Date())}</span>
          </span>
          <button className="ghost small" aria-label={`Stop always allowing ${describeRule(rule)} for ${names.get(rule.by) ?? rule.by}`} onClick={() => void forgetRule(rule)}>Remove</button>
        </li>)}
      </ul>}
    {removedNote && <p className="allowed-removed" role="status"><span aria-hidden="true">✓</span>{removedNote}</p>}
  </>;
  const changedFiles = new Set(changes.map((c) => c.change.path)).size;
  const newArtifacts = unseenArtifacts > 0 && !liveView;
  // Labels hide on a crowded top line, so each button names itself for screen readers.
  const threadCounts = (
    <div className="thread-counts">
      {artifacts.artifacts.length > 0 && <button key={artifactGlow || undefined} className={`ghost small${liveView ? " on" : ""}${artifactGlow ? " artifact-glow" : ""}`} aria-pressed={liveView !== null} aria-label={`Artifacts · ${artifacts.artifacts.length}${newArtifacts ? `, ${unseenArtifacts} new` : ""}`} title="Artifacts" onClick={toggleArtifacts}>
        <ArtifactsIcon /><span className="count-label">Artifacts · </span>{artifacts.artifacts.length}{newArtifacts && <span className="new-dot" aria-hidden="true" />}
      </button>}
      {changes.length > 0 && <button className="ghost small" aria-label={`Changes · ${changedFiles}`} title="Changes" onClick={() => { setTurnPaths(null); setFocusPath(null); details?.show("changes"); loadDiff(); }}>
        <ChangesIcon /><span className="count-label">Changes · </span>{changedFiles}
      </button>}
    </div>
  );
  // The bots sit in their own row under the message box.
  /** The bots the message goes to, as the room last answered. */
  const lit = new Set(serverTargets);
  const botChips = (
    <div ref={chipRow} data-chip-style={chipParts.style ?? "classic"} className={`chips composer-bots${folded ? " folded" : ""}`}>
      {participants.map((p) => {
        const levels = levelsFor(p.id);
        const shown = levelsShown(levels, chipParts, isLow);
        const queueCount = queued.filter(item => item.to.includes(p.id)).length;
        const phase: string = working[p.id] ? working[p.id].phase : "idle";
        const stateLabel = `${p.display_name}: ${phase}${isLow(levels.context) ? ", context low" : ""}${isLow(levels.plan) ? ", plan low" : ""}${queueCount ? `, ${queueCount} queued` : ""}${editor === p.id ? ", editing" : ""}${lit.has(p.id) ? ", gets your message" : ""}`;
        return (
        <span
          className="chip-wrap"
          key={p.id}
          onMouseEnter={(e) => hoverCard(p.id, e.currentTarget)}
          onMouseLeave={() => leaveCard(p.id)}
          onFocus={(e) => hoverCard(p.id, e.currentTarget)}
          onBlur={(e) => { const to = e.relatedTarget as Node | null; if (!e.currentTarget.contains(to) && !cardBox.current?.contains(to)) setCard((open) => (open === p.id ? null : open)); }}
          onKeyDown={(e) => { if (e.key === "Escape") setCard(null); }}
        >
            <span data-editing={editor === p.id} className={lit.has(p.id) ? "chip to" : "chip"} style={{ "--who": color(p.id) } as CSSProperties}>
              <button className="chip-name" aria-label={`${stateLabel} · ${chipDescription(p, chipParts)} · ${p.backend.kind === "agent" || p.backend.kind === "open_ai_compatible" ? "open bot settings" : "mention bot"}`} onPointerDown={(event) => event.preventDefault()} aria-haspopup={p.backend.kind === "agent" || p.backend.kind === "open_ai_compatible" ? "dialog" : undefined} aria-expanded={quickSettings?.id === p.id} onClick={(event) => {
                if (p.backend.kind === "agent" || p.backend.kind === "open_ai_compatible") {
                  setCard(null);
                  setQuickSettings(quickSettings?.id === p.id ? null : { id: p.id, anchor: event.currentTarget });
                } else mention(p);
              }} title={`${stateLabel} · ${chipDescription(p, chipParts)}`}>
                <Avatar seed={appearance(p.id).seed} color={color(p.id)} size="sm" working={Boolean(working[p.id]) && !asks[p.id]?.length} levels={levels} refills={refillsFor(p.id)} />
                <span className={`participant-status ${working[p.id]?.phase ?? "idle"}`} aria-label={`${p.display_name}: ${working[p.id]?.phase ?? "idle"}`} />
                {(chipParts.style === "stack" || chipParts.style === "tiles") && (isLow(levels.context) || isLow(levels.plan)) && <span className="chip-low" title="Usage running low">low</span>}
                <span className="chip-copy">
                <span className="chip-label">{p.display_name}</span>
                <span className="chip-details">
                {(chipParts.style === "ledger" || chipParts.style === "two-line") && <span className="chip-phase">{phase === "idle" ? "Idle" : "Working"}</span>}
                {pendingSettings[p.id] && <span className="settings-pending" role="status" aria-label="Settings pending for next reply" title="Settings apply to the next reply" />}
                {queueCount > 0 && <span className="chip-meta chip-queued" title="Messages waiting for this bot">{queueCount}<span className="chip-queued-word"> queued</span></span>}
                {editor === p.id && <span className="editor-badge">editing</span>}
                <span className="chip-meta chip-description">{chipDescription(p, chipParts)}</span>
                {(shown.context !== null || shown.plan !== null) && (
                  <span className="chip-meta chip-levels">
                    {shown.context !== null && <span title="Context left">ctx {percent(shown.context)}%{isLow(shown.context) && <span className="usage-low"> low</span>}</span>}
                    {shown.context !== null && shown.plan !== null && <span className="chip-sep" aria-hidden="true">·</span>}
                    {shown.plan !== null && <span title="Plan left">plan {percent(shown.plan)}%{isLow(shown.plan) && <span className="usage-low"> low</span>}</span>}
                  </span>
                )}
                </span>
                </span>
              </button>
              {!profileMode && <button type="button" className="chip-kick" disabled={!ready} aria-label={`Kick ${p.display_name}`} title={`Kick ${p.display_name}`} onPointerDown={(event) => event.preventDefault()} onClick={() => kick(p)}>×</button>}
            </span>
        {card === p.id && !quickSettings && createPortal(usageCard(p, cardAt), document.body)}
        </span>
        );
      })}
      {/* The chip row keeps the add button when the last bot is gone too: a notice
          (a kick, a load error) hides the empty state's own button, so without
          this seat an empty thread would have no way to add a bot back. */}
      {(participants.length > 0 || entries.length > 0) && (
        <span className="quick-add-wrap roster">
          <button className="chip-add" onPointerDown={(event) => event.preventDefault()} disabled={!ready} aria-label="Add bot" title="Add bot" aria-haspopup="dialog" aria-expanded={quickAdd === "dock"} onClick={(e) => { if (availablePresets.length === 0 && availableProfiles.length === 0) openNewForm(); else openQuickAdd("dock", e.currentTarget); }}>
            <PersonPlus /><span className="chip-add-label">Add bot</span>
          </button>
        </span>
      )}
      {participants.length > 0 && !profileMode && (
        <button type="button" className="chips-fold" aria-pressed={folded} aria-label={folded ? "Show bot details" : "Fold bots to avatars"} title={folded ? "Show bot details" : "Fold bots to avatars"}
          onPointerDown={(event) => event.preventDefault()} onClick={toggleFolded}>{folded ? "›" : "‹"}</button>
      )}
    </div>
  );

  const landing = entries.length === 0 && Object.keys(drafts).length === 0;

  return (
    <div ref={root} data-bot-chip-style={chipParts.style ?? "classic"} className={`chat ${profileMode ? "" : `thread-chat${landing ? " thread-landing" : ""}`}`}>
      {!profileMode && <ConnectionBanner backend={backend} />}
      {!profileMode && headSlot && createPortal(<><VoiceCallCapsule settings={voiceConfig} candidates={voiceCandidates} who={voiceWho} />{threadCounts}</>, headSlot)}

      {quickSettings && participants.find(p => p.id === quickSettings.id) && <BotSettings key={quickSettings.id} roomId={pane.id} config={participants.find(p => p.id === quickSettings.id)!} anchor={quickSettings.anchor} backend={backend} close={closeQuickSettings} avatar={<Avatar seed={appearance(quickSettings.id).seed} color={color(quickSettings.id)} working={Boolean(working[quickSettings.id]) && !asks[quickSettings.id]?.length} levels={levelsFor(quickSettings.id)} refills={refillsFor(quickSettings.id)} />} meters={(() => { const levels = levelsFor(quickSettings.id); const now = Date.now() / 1000; const row = (name: string, level: number | null, title: string, resetsAt?: number | null, used = false) => { const shown = level === null ? null : used ? 1 - level : level; return <span key={title} className="bot-meter" title={resetsAt != null ? `${title} · resets ${resetDate(resetsAt)}` : title}>{name}<span className="bot-meter-track" aria-hidden="true">{shown !== null && <span style={{ width: `${percent(shown)}%` }} className={isLow(level!) ? "low" : undefined} />}</span>{shown === null ? "—" : `${percent(shown)}%`}<span className="bot-meter-timer">{resetsAt != null ? countdown(resetsAt, now) : ""}</span></span>; }; const provider = planProvider(configOf(quickSettings.id)); const windows = provider ? liveWindows(plans[provider]?.windows ?? [], now) : []; return <span className="bot-meters">{!makesMedia(configOf(quickSettings.id)) && row("ctx", levels.context, "Context used", null, true)}{windows.length ? windows.map(w => row(w.window_minutes === 10_080 ? "wk" : w.window_minutes === 300 ? "5h" : windowLabel(w), 1 - Math.min(100, w.used_percent) / 100, `${windowLabel(w)} limit left`, w.resets_at)) : moneyRow(configOf(quickSettings.id)) ?? (accountOf(configOf(quickSettings.id)) ? null : row("plan", levels.plan, "Plan left"))}</span>; })()} save={async (config, base) => {
        const saved = await backend.roomUpdateParticipant(pane.id, config, base);
        // Attach mode never creates the room: a popped view edits only while the owner has it open.
        if (!saved && attach) { setFormError("This chat isn't open in Deck right now. Return it to Deck and try again."); return; }
        const actual = saved || (await backend.roomCreate(pane.id, [], { policy: "mention", max_bot_hops: 0 }, "")).participants.find(p => p.id === config.id) || config;
        if (!saved) setParticipants(list => list.map(p => p.id === config.id ? actual : p));
        if (turnQueue.state[config.id] === "working") setPendingSettings(all => ({ ...all, [config.id]: true }));
      }} /> }
      {!profileMode && details?.target === pane.id && details.open && details.slot && createPortal(<ThreadDetails host={details} title={pane.title} cwd={cwd} subtitle={[workspaceName, participants.length === 1 ? "1 bot" : `${participants.length} bots`].filter(Boolean).join(" · ")} bots={botControls} form={modelForm} room={roomControls} allowed={allowedList} changes={<DiffPanel diff={diff} loading={diffLoading} order={participants.map(p => p.id)} onRefresh={loadDiff} nameOf={id => names.get(id) ?? id} colorOf={color} appearanceOf={appearance} onReveal={path => openTarget(path, true)} reviewers={reviewerRows(participants)} onReview={askForReview} paths={turnPaths} focusPath={focusPath} onClearScope={() => { setTurnPaths(null); setFocusPath(null); }} cwd={cwd} />} />, details.slot)}
      {profileMode && !adding && participants.length > 0 && <div className="chat-bar"><div className="chips">{addButton}</div></div>}

      {!profileMode && pins.length > 0 && pinControls}

      {profileMode && adding && modelForm}

      {profileMode && !adding && <div className="agent-library">
        {participants.length === 0 && <div className="empty agents-empty">
          <LandingTexture settings={landingTexture} />
          <h3>No agents yet</h3>
          <p>Build one from scratch — give it a name, a model, and a brief.</p>
          <div className="starters-foot">
            <span className="muted">Or save a bot from a thread with Save to Agents.</span>
            <button className="primary" onClick={openNewForm} disabled={availablePresets.length === 0}>+ New agent</button>
          </div>
        </div>}
        {participants.map((p) => <article className="agent-card" key={p.id}>
          <Avatar seed={appearance(p.id).seed} color={color(p.id)} size="lg" />
          <div className="agent-card-copy"><h2>{p.display_name}</h2><p className="muted">{chipDescription(p, ALL_PARTS)}</p><p>{p.persona || "No brief added yet."}</p><span className="hint">@{mentionFor(p)} · {p.access === "read" ? "Read only" : p.access === "ask" ? "Asks first" : p.access === "edits" ? "Can edit files" : "Full access"}</span></div>
          <div className="agent-card-actions"><button onClick={() => startEditing(p)}>Edit</button><button className="ghost" onClick={() => removeParticipant(p.id)} aria-label={`Delete agent ${p.display_name}`}>Delete</button></div>
        </article>)}
      </div>}

      {!profileMode && <div className="chat-body" ref={chatBody}>
      <div className="transcript" ref={scroller} onScroll={() => { setPicked(null); onTranscriptScroll(); }}
        onMouseUp={() => requestAnimationFrame(pickSelection)} onKeyUp={(e) => e.shiftKey && pickSelection()}
        onMouseDown={(e) => { if (!(e.target as Element).closest(".selection-actions")) setPicked(null); }}>
        {picked && <span className="selection-actions" role="toolbar" aria-label="Selected text" style={{ left: picked.x, top: picked.y }}>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={addPicked}>Add to chat</button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={explainPicked} disabled={!ready || participants.length === 0}>More details</button>
        </span>}
        {landing && (
          <div className={`empty${quickAdd === "dock" ? " away" : ""}`}>
            <LandingTexture settings={landingTexture} />
            <div className="empty-copy">
              <div className="empty-emblem"><DeckIcon name="chat" size={26} /></div>
              <span className="eyebrow">A fresh perspective starts here</span>
              {work ? <>
                {/* Codex's opening question: the project's name opens the picker. */}
                <h3 className="ask">What should we work on in <button type="button" className="pick-name" onClick={() => setAskPicker((n) => n + 1)}>{work.project.name}</button>?</h3>
                <p className="where">{!work.project.path ? "No project: the bots work without a project folder."
                  : work.project.hostId === "local" ? `On This Mac · ${work.project.path}`
                  : `On ${work.project.hostName} · ${work.project.path}${work.workRows.some((r) => r.hostId === "local" && r.workspaceId) ? " · a separate copy from your Mac's" : ""}`}</p>
              </> : <h3>{participants.length === 0 ? "Build your thinking team." : "The room is yours."}</h3>}
              <p>
                {participants.length === 0
                  ? "Add two or more models, then ask them something. Each one sees the whole conversation."
                  : "Type a message below. Use @name to pick who answers, or @all for everyone."}
              </p>
              {participants.length === 0 && <button className="primary" disabled={!ready || (availablePresets.length === 0 && availableProfiles.length === 0)} aria-haspopup="dialog" aria-expanded={quickAdd === "dock"} onClick={(e) => openQuickAdd("dock", e.currentTarget)}>+ Add bots</button>}
              {participants.length > 0 && <div className="example-rows" aria-label="Examples">
                {exampleRows(participants).map((row) => (
                  <button key={row.text} type="button" className="example-row" onClick={() => insertExample(row.text)}>{row.label}</button>
                ))}
              </div>}
            </div>
          </div>
        )}
        {pane.fork && pane.fork.at === 0 && forkLine}
        {transcriptMounted.current && entries.flatMap((entry) => {
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
                <AttachedImages paths={attachedImages(entry.message.text)} read={backend.readAttachment} onOpen={(path) => openTarget(path, true)} onLoad={() => settle.current()} />
                <AttachedVideos paths={attachedVideos(entry.message.text)} read={backend.readAttachment} onOpen={(path) => openTarget(path, true)} onLoad={() => settle.current()} />
              </div>
            </div>
          ) : (
            <div key={`m${entry.message.seq}`} className="bot-row message-row">
              <Avatar
                seed={appearance(entry.message.speaker.id).seed}
                color={color(entry.message.speaker.id)}
                {...(newestReply.get(entry.message.speaker.id) === entry.message.seq ? { levels: levelsFor(entry.message.speaker.id), refills: refillsFor(entry.message.speaker.id) } : {})}
              />
              <div className="bubble bot completed" data-seq={entry.message.seq} data-activity="idle" style={{ "--agent-color": color(entry.message.speaker.id) } as CSSProperties}>
                <span className="speaker">
                  {names.get(entry.message.speaker.id) ?? entry.message.speaker.id}
                </span>
                <Markdown text={entry.message.text} onOpen={openTarget} pathExists={pathExists} codeAction={(code) => <>{runAction(entry.message, code)}{artifactAction(entry.message, code)}</>} codeBelow={(code) => runBelow(entry.message, code)} fence={cardIn(entry.message)} />
                <AttachedImages paths={replyImages(entry.message.text)} read={readReplyImage(names.get(entry.message.speaker.id) ?? entry.message.speaker.id)} onOpen={(path) => openTarget(path, true)} onLoad={() => settle.current()} />
                <AttachedVideos paths={replyVideos(entry.message.text)} read={readReplyImage(names.get(entry.message.speaker.id) ?? entry.message.speaker.id)} onOpen={(path) => openTarget(path, true)} onLoad={() => settle.current()} />
                {(() => {
                  const files = turnFiles.get(entry.message.seq);
                  if (!files?.length) return null;
                  return <ChangedFilesStrip files={files} onOpenFile={(path) => openTurnDiff(entry.message.seq, path)} onOpenTurn={() => openTurnDiff(entry.message.seq)} />;
                })()}
                {(() => {
                  const seq = entry.message.seq;
                  const saved = savedEntry(stepsIndex, seq);
                  if (!saved) return null;
                  const load = async () => {
                    const reply = readReplySteps(await backend.roomSteps(pane.id, seq));
                    if (reply) loadedSteps.current.set(seq, reply);
                    return reply;
                  };
                  return <SavedSteps count={saved.count} cached={loadedSteps.current.get(seq) ?? null} load={load} />;
                })()}
              </div>
              {messageActions(entry.message)}
            </div>
          );
          // "New since you looked" goes above the first reply you have not seen.
          const after = entry.kind === "message" && entry.message.seq === forkAfter ? [forkLine] : [];
          return entry.kind === "message" && entry.message.seq === dividerAt
            ? [<div key={`u${entry.message.seq}`} className="unseen-divider" role="separator" aria-label="New since you looked"><span>New since you looked</span></div>, item, ...after]
            : [item, ...after];
        })}
        {transcriptMounted.current && Object.entries(drafts).map(([id, partial]) => {
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
              <div className="bubble bot writing" aria-busy="true" data-activity={asks[id]?.length ? "waiting" : "working"} style={{ "--agent-color": color(id) } as CSSProperties}>
                <span className="speaker">
                  {names.get(id) ?? id}
                </span>
                {turn?.work.structured ? (
                  <WorkSteps turn={turn.work} live />
                ) : steps.length > 0 && (
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
                    <Markdown text={partial} onOpen={openTarget} fence={(code) => (code.language === CARD_LANGUAGE ? <PreparingCard author={names.get(id) ?? id} /> : undefined)} />
                  </div>
                )}
                {(asks[id] ?? []).map((ask) => (
                  <ApprovalCard
                    hostName={backend.host?.name ?? "This Mac"} disabled={!ready}
                    key={ask.request}
                    request={ask.request}
                    by={id}
                    action={ask.action}
                    name={names.get(id) ?? id}
                    deadline={deadlineNote(ask.action.expires_at, now)}
                    onDecide={(approve, always) => backend.roomDecide(pane.id, ask.request, approve, always)}
                  />
                ))}
                {answered[id] && <div className="qform-answered">You answered: {answered[id]}</div>}
                <div className={`working-line ${asks[id]?.length ? "asking" : quiet ? "quiet" : ""}`} role="status">
                  <span className="working-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>{asks[id]?.length ? "Waiting for you" : quiet ?? (planOn ? "Planning" : phaseLabel(turn?.phase))}</span>
                  {turn && !quiet && <span className="working-time">{elapsed(now - turn.startedAt)}</span>}
                  {turn && <button type="button" className="bubble-stop" aria-label={`Stop ${names.get(id) ?? id}`} title={chargeWarning([id]) ? `Stop ${names.get(id) ?? id}. ${chargeWarning([id])}` : `Stop ${names.get(id) ?? id}`} onClick={() => stopBots(id)}><StopSquare /> Stop</button>}
                </div>
              </div>
            </div>
          );
        })}
        {queued.map((item) => {
          const who = item.to.map((id) => names.get(id) ?? id).join(", ");
          const steerable = !item.failed && item.kind === "message" && item.to.some((id) => working[id]);
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
              <span className="q-for">{item.failed ? "Send unconfirmed for" : queuePaused ? "Paused for" : "Queued for"} {item.to.slice(0, 1).map((id) => <Avatar key={id} seed={appearance(id).seed} color={color(id)} size="sm" />)}<span>{who}</span></span>
              {queuePaused && !item.failed && <><i className="q-sep" /><button type="button" onClick={() => { setQueuePaused(false); turnQueue.resume(); }}>Resume</button></>}
              {steerable && <><i className="q-sep" /><button type="button" title={`Send to ${who} now, mid-turn (⌘↵)`} onClick={() => askToSteer(item)}>Steer <SteerArrow /></button></>}
              <i className="q-sep" />
              {item.failed && <button type="button" title="The host may already have received this message. Check the chat before retrying." onClick={() => turnQueue.retry(item.id)}>Retry send</button>}
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
      </div>
      {!profileMode && (unread > 0 || cardsAway.length > 0) && <div className="transcript-pills">
        {cardsAway.length > 0 && <button type="button" className="transcript-pill" onClick={() => showCard(cardsAway[0].request)}>
          <span className="pill-dot" aria-hidden="true" />
          {waitingLine(owners(cardsAway).map((id) => names.get(id) ?? id))} · Show
        </button>}
        {unread > 0 && <button type="button" className="transcript-pill" onClick={jumpToLatest}>{newPill(unread)}</button>}
      </div>}
      {!profileMode && !artifactsHost && panel && narrow && !panel.full && <button type="button" className="artifacts-backdrop" aria-label="Close artifacts" onClick={() => setPanel(null)} />}
      {!profileMode && !artifactsHost && panel && (
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
      {!profileMode && artifactsHost && dockedHere && artifactsHost.slot && createPortal(
        <ArtifactsPanel
          file={artifacts}
          view={{ ...(panel ?? DEFAULT_VIEW), full: artifactsHost.full }}
          onView={(next) => {
            if (next.full !== artifactsHost.full) artifactsHost.setFull(next.full);
            setPanel({ ...next, full: false });
          }}
          onClose={artifactsHost.close}
          overlay={false}
          docked
          expandable={artifactsHost.expandable}
          nameOf={(id) => names.get(id) ?? id}
          colorOf={color}
          onOpenLink={openTarget}
          backend={backend}
          problem={artifactProblem}
        />, artifactsHost.slot)}
      {!profileMode && !(panel && !artifactsHost) && modDock.length > 0 && <ModDock panes={modDock} overlay={narrow} />}
      </div>}

      {!profileMode && <div className={`composer${tldr ? " tldr" : ""}${planOn ? " plan" : ""}`} ref={composer}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); attachFiles(e.dataTransfer.files); } }}>
        <input ref={filePicker} type="file" accept="image/*,.pdf,.txt,.md,.csv,.json,.log" multiple hidden
          onChange={(e) => { if (e.target.files) attachFiles(e.target.files); e.target.value = ""; }} />
        <div className="composer-input">
        {attached.length > 0 && <div className="attachments" aria-label="Attachments">
          {attached.map((a) => <div className="attachment" key={a.id} title={a.path ?? `${a.name} (saving…)`} aria-busy={!a.path}>
            {a.preview ? <img src={a.preview} alt={a.name} /> : <span className="attachment-name">{a.name}</span>}
            <button className="icon small" aria-label={`Remove ${a.name}`} onClick={() => unattach(a.id)}>×</button>
          </div>)}
        </div>}
        {!profileMode && <QuestionForm view={form} nameOf={(id) => names.get(id) ?? id} colorOf={color}
          highlighted={highlighted} collapsed={formFolded} notice={formNotice}
          onHighlight={setHighlighted} onExpand={() => setFormFolded(false)}
          onAnswer={answerQuestion} onStep={sendStep} onDismiss={() => dismissSteps(pane.id)} />}
        {moveAsk && <div className="move-ask" role="group" aria-label="Open it somewhere else">
          <p>{moveAsk.why
            ? <>{moveAsk.why} This thread stays where it is. Open <b>{moveAsk.project}</b> as:</>
            : <>This thread runs on <b>{moveAsk.stays}</b> and stays there. Open <b>{moveAsk.project}</b> on <b>{moveAsk.host}</b> as:</>}</p>
          <div>
            <button type="button" className="primary" data-act="ask-new" onClick={moveAsk.onNew}>New thread</button>
            {moveAsk.onFork && <button type="button" data-act="ask-fork" onClick={moveAsk.onFork}>Fork this thread</button>}
            <button type="button" className="ghost" data-act="ask-cancel" onClick={moveAsk.onCancel}>Cancel</button>
          </div>
        </div>}
        {replies.length > 0 && <div className="quote-preview">
          <div className="quote-preview-head">
            <span className="quote-count">{replies.length === 1 ? "1 quote" : `${replies.length} quotes`}</span>
            <span className="quote-head-actions">
              <span className="pane-menu-wrap hand-off">
                <button ref={handOffButton} type="button" className="ghost small" aria-haspopup="menu" aria-expanded={handOffOpen} onClick={() => setHandOffOpen((open) => !open)}>
                  {handOffLabel(quoteTo, (id) => names.get(id) ?? id)} ▾
                </button>
                {handOffOpen && <span className="pane-menu hand-off-menu" role="menu">
                  {handOffChoices(quoteTo, participants.map((p) => ({ id: p.id, name: p.display_name }))).map((choice) => (
                    <button role="menuitem" key={choice.to} onClick={() => { setReplies((list) => list.map((quote) => ({ ...quote, to: choice.to }))); setHandOffOpen(false); input.current?.focus(); }}>{choice.label}</button>
                  ))}
                </span>}
              </span>
              {replies.length > 1 && <button type="button" className="quote-clear-all" onClick={() => { setReplies([]); input.current?.focus(); }}>Clear all</button>}
            </span>
          </div>
          <div className="quote-preview-list">{replies.map((item, index) => (
            <div className="quote-preview-row" key={`${item.id}:${item.name}:${index}`}><span className="quote-author" title={item.id ? item.name : "You"}>{item.id ? item.name : "You"}</span><blockquote>{item.text}</blockquote><button className="quote-cancel" aria-label={`Remove quote ${index + 1}`} onClick={() => { setReplies((list) => list.filter((_, i) => i !== index)); input.current?.focus(); }}>×</button></div>
          ))}</div>
        </div>}
        {/* One line: + on the left, the text, then TL;DR and Send. They stay by the last line as the text grows.
            A thread with no messages yet adds a row under it to pick the project and machine; after that, + has Files and Tools. */}
        <VoiceCallBar settings={voiceConfig} candidates={voiceCandidates} who={voiceWho} />
        <div className={`composer-box${stacked ? " stacked" : ""}${work && !work.started ? " with-tray" : ""}${quickAdd === "dock" ? " adding" : ""}`} ref={field}>
          {quickAdd === "dock" && quickAddMenu}
          <ComposerMenu ref={composerMenu} planOn={planOn} participants={participants} mods={modHost.allCommands()} servers={serverTargets.flatMap(agent => (serverLists[agent] ?? []).map(entry => ({agent, ...entry})))} serverStatus={serverTargets.map(id => serverErrors[id] ?? (serverLists[id] ? "" : `Loading ${names.get(id) ?? id}’s servers, apps and plugins…`)).filter(Boolean).join(" · ")} trigger={findTrigger(text, caret)} choose={(item, trigger) => {
            if (item.kind === "attach") return filePicker.current?.click();
            if (item.kind === "attach-folder") return void backend.pickFolder().then((path) => path && track(`${path.split("/").pop() || path}/`, undefined, () => backend.copyAttachment(pane.id, path)));
            if (item.kind === "command" && item.command) {
              const draft = text;
              runCommand(item.command);
              setText(trigger ? text.slice(trigger.end) : draft);

            } else {
              const next = insertAt(text, trigger, caret, item.kind === "tools" ? "!" : `${item.label} `);
              setText(next.text); setCaret(next.caret);
              requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
            }
            input.current?.focus();
          }} />
          <div className="composer-field">
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
            if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && formKeys(e.key)) { e.preventDefault(); return; }
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "t") { e.preventDefault(); toggleTldr(); return; }
            // Esc stops every bot and keeps your draft, like Claude Code and Codex.
            if (e.key === "Escape" && busy) { e.preventDefault(); stopBots(); return; }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e.metaKey || e.ctrlKey);
            }
          }}
          rows={1}
          placeholder={waitingForOwner ? "Waiting for Deck…" : voiceHint ?? (form.kind === "steps" && !text ? form.offer.steps[0].prompt : copy.placeholder)}
          disabled={!roomReady || participants.length === 0}
        />
          </div>
        {planOn && !profileMode && (
          <button type="button" className="plan-chip" title="Plan is on: every bot plans and changes nothing. Click to turn it off."
            aria-label="Plan is on. Turn it off" onPointerDown={(event) => event.preventDefault()} onClick={() => void setPlan(false)}>
            <span aria-hidden="true">◇</span><span className="plan-chip-label">Plan</span><span className="plan-chip-x" aria-hidden="true">✕</span>
          </button>
        )}
        <button type="button" className="tldr-pill" aria-pressed={tldr} aria-label="TL;DR mode" title={`TL;DR mode ${tldr ? "on" : "off"}: take a chill pill (⌘⇧T)`}
          // Keep focus in the message box, so you can type straight after.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => { toggleTldr(); input.current?.focus(); }}><span aria-hidden>TL;</span><span aria-hidden>DR</span></button>
          {/* One round button: the mic while the box is empty, Send once it has something. Each reply keeps its own Stop, and Esc stops them all. */}
          {roundButton.mic && <VoiceCallControls settings={voiceConfig} candidates={voiceCandidates} who={voiceWho} disabled={!ready || saving} />}
          {roundButton.send && pricePill && <span className="media-price-pill" title="What this message is expected to cost">Send · {pricePill}</span>}
          {roundButton.send && <button type="button" className="round-send" aria-label="Send" title="Send (↵)" onClick={() => { if (Date.now() - flippedAt.current > 600) void send(); }} disabled={!ready || (!text.trim() && !sendable.length) || saving || participants.length === 0}><SendArrow /></button>}
          {work && !work.started && <WorkBar work={askPicker ? { ...work, pickerRequest: (work.pickerRequest ?? 0) + askPicker } : work} attachedCount={attached.length} files={recent} tools={workTools}
            toolsWhere={`on ${backend.host?.name ?? "This Mac"}`} canCopyFolder={!backend.host || backend.host.id === "local"}
            onAttach={attachPath} onTool={useTool}
            onCopyFolder={() => void backend.pickFolder().then((path) => path && track(`${path.split("/").pop() || path}/`, undefined, () => backend.copyAttachment(pane.id, path)))} />}
        </div>
        {unknownServers.length > 0 && <div className="server-error">{unknownServers.map(name => <u key={name}>!{name} </u>)} — unknown server, app or plugin</div>}
        {botChips}
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

function ArtifactsIcon() {
  return <svg className="count-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M9 14l-2 2 2 2m6-4 2 2-2 2" /></svg>;
}

function ChangesIcon() {
  return <svg className="count-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 4v8M8 8h8M8 18h8" /></svg>;
}

function PersonPlus() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4" /><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M19 8v6M16 11h6" /></svg>;
}
