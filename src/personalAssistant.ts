// The personal assistant lives on a durable host (the VPS). Clients only
// read its record and send it events; the host owns every task, approval
// and receipt (crates/apex-host/src/personal.rs).

import { usePersonalAssistants, type PersonalAssistantsOptions } from "./usePersonalAssistants.ts";
import type { Backend } from "./backend";
import type { ParticipantConfig } from "./types";
import type { AssistantLook, AssistantProjectBinding } from "./assistantIdentity.ts";
import type { ProjectMemoryApi } from "./projectMemory.ts";

export type PersonalLegacyMarker = { sourceSha256: string; importedAtMs: number; originalId?: string; originalStatus?: string; verified: false };
export type PersonalMessage = { id: string; role: "human" | "assistant" | "system"; kind: "chat" | "approval" | "result" | "update" | "helper" | "notice"; text: string; at: number; taskId?: string; eventId?: string; reactions?: string[]; legacy?: PersonalLegacyMarker };
export type ToolClass = "read" | "write" | "send" | "spend";
/** Dot's four rule choices: do it without asking, only when I say so, ask first, hand it to me. */
export type ActionMode = "auto" | "onRequest" | "ask" | "handOff";
export type PersonalDecision = { id: string; kind: "approve" | "uncertain" | "handOff" | "spend" | "schedule"; paramsHash: string; prompt: string; status: "open" | "approved" | "denied" | "superseded"; openedAt: number; decidedAt?: number };
export type PersonalReceipt = { opId: string; phase: "attempted" | "verified" | "failed" | "uncertain"; exitCode?: number; outputExcerpt: string; rerunAfterRestart: boolean; note?: string; startedAt: number; finishedAt?: number };
export type StopCondition = { exitCode?: number; outputContains?: string; outputLacks?: string };
/** When and how often an approved operation runs. Part of what an approval covers. */
export type RunPlan = { startAt?: number; everyMs?: number; maxRuns?: number; until?: StopCondition; timeoutMs?: number; deadlineAt?: number; after?: string };
export type TaskWait = { kind: "timer"; at: number } | { kind: "dependency"; taskId: string } | { kind: "machine"; hostId: string };
export type PersonalTask = {
  deletedAt?: number;
  id: string; goal: string; completionCriteria: string[]; targetHost: string;
  status: "needsYou" | "queued" | "running" | "waiting" | "blocked" | "done" | "failed" | "cancelled";
  /** What kind of action it is, which decides whether it asks first. */
  class?: ToolClass;
  /** `helper`: a research job that only reads and reports back. */
  kind?: "command" | "helper";
  operation?: { tool: string; host: string; cwd: string; argv: string[]; plan?: RunPlan };
  decision?: PersonalDecision; receipts: PersonalReceipt[]; lastUpdate?: string; updatedAt: number; createdAt?: number;
  wait?: TaskWait; runsDone?: number; parent?: string; scheduleId?: string;
};
export type Fact = {
  id: string; text: string; kind: "preference" | "fact" | "decision" | "commitment";
  /** The human said it outright, rather than the assistant inferring it. */
  explicit: boolean; confidence: number;
  source: { messageId?: string; taskId?: string }; createdAt: number;
  expiresAt?: number; supersededBy?: string; deletedAt?: number;
  legacy?: PersonalLegacyMarker;
};
export type Schedule = { id: string; goal: string; argv: string[]; everyMs?: number; dailyAt?: string; nextAt?: number; status: "proposed" | "active" | "cancelled"; createdAt: number; lastTaskId?: string; runs: number; paramsHash: string; decision?: PersonalDecision };
export type Notice = { id: string; text: string; taskId?: string; urgent: boolean; at: number; deliverAt: number; deliveredAt?: number; seenAt?: number; fingerprint: string };
export type CostEntry = { at: number; purpose: "reply" | "helper" | "summary" | "check" | "avatar"; kind: "text" | "image" | "audio" | "video" | "tool"; source: "reported" | "estimated" | "unknown"; micros?: number; inputTokens?: number; outputTokens?: number; bytesOut: number; endpoint: string };
export type StandingRule = { id: string; text: string; class: ToolClass; mode: ActionMode; createdAt: number };
export type PersonalSettings = {
  name: string; style: string; look?: AssistantLook;
  timezone: string; quietHours?: { start: string; end: string };
  modes: Record<ToolClass, ActionMode>;
  budget: { dailyLimitMicros?: number; unknownCostOk?: boolean };
  privacy: { localOnly: boolean; allowedEndpoints: string[] };
  contextBudgetChars: number;
  utcOffsetMinutes?: number;
};
export type PersonalAssistantRecord = PersonalSettings & {
  legacy?: PersonalLegacyMarker;
  archivedAt?: number;
  id: string; hostId: string; allowedFolders: string[]; paused?: boolean; revision: number;
  /** Assistant-owned snapshot; changing it never edits a reusable Agents profile. */
  profile: ParticipantConfig | null;
  /** Missing on older hosts; assignments do not create machine/folder grants. */
  projects?: AssistantProjectBinding[];
  messages: PersonalMessage[]; tasks: PersonalTask[];
  purgedDelegatedTaskIds?: string[];
  taskLifecycleSnapshotRevision?: number;
  deletedDelegatedTasks?: import("./assistantTaskModel.ts").AssistantTask[];
  events?: { id: string; requestId: string; state: 'received' | 'processing' | 'held' | 'done' | 'failed'; error?: string; source?: { kind: string; text?: string }; receivedAt?: number }[];
  rules?: StandingRule[]; facts?: Fact[]; schedules?: Schedule[]; notices?: Notice[]; costs?: CostEntry[];
  machines?: { hostId: string; name: string; folder: string; lastSeen?: number }[];
};

/** Versioned transaction: callers retain the revision from their editor draft. */
export type PersonalWorkspaceConfigure = {
  expectedRevision: number;
  avatar?: import("./assistantAvatar.ts").AvatarSelection;
  settings?: Omit<Partial<PersonalSettings>, 'quietHours'> & { quietHours?: PersonalSettings['quietHours'] | null };
  profile?: ParticipantConfig;
  projects?: AssistantProjectBinding[];
};

/** What the ApexAgent conversation needs to show and talk to the personal assistant. */
export type PersonalLane = {
  /** Host-qualified keys for composer drafts and attachment ownership. */
  ref?: import("./assistantIdentity.ts").AssistantRef;
  draftKey?: string;
  attachmentKey?: string;
  name: string;
  hostName: string;
  assistant: PersonalAssistantRecord | null;
  offline: boolean;
  /** Why the lane can't be used, such as an older service. */
  problem?: string;
  setUp?: () => Promise<void>;
  send(text: string): Promise<void>;
  sendRequest?(text: string, requestId: string): Promise<{eventId: string}>;
  cancelReply?(eventId: string): Promise<void>;
  archiveAssistant?(expectedRevision: number): Promise<void>;
  react(messageId: string, emoji: string, enabled: boolean): Promise<void>;
  saveAttachment(name: string, bytes: Uint8Array): Promise<string>;
  pickFolder(): Promise<string | null>;
  decide(decisionId: string, paramsHash: string, approve: boolean): Promise<void>;
  cancel(taskId: string): Promise<void>;
  /** Host-backed deletion; restoring cancelled tasks never restarts them. Empty requires the exact displayed key set. */
  taskLifecycle?(action: 'delete' | 'restore' | 'empty', task?: { source: 'personal' | 'delegated'; taskId: string; revision?: number }, expectedDeleted?: string[]): Promise<void>;
  /** Pause stops new work starting; the assistant keeps answering. */
  pause?(paused: boolean): Promise<void>;
  /** Change name, style, modes, quiet hours, budget or privacy. Only what's given changes. */
  configure?(settings: Partial<PersonalSettings>): Promise<void>;
  /** Only available when the authenticated route advertises assistant_workspace_v4. */
  configureWorkspace?(configuration: PersonalWorkspaceConfigure): Promise<PersonalAssistantRecord | void>;
  addRule?(text: string, cls: ToolClass, mode: ActionMode): Promise<void>;
  removeRule?(ruleId: string): Promise<void>;
  remember?(text: string): Promise<void>;
  correctFact?(factId: string, text: string): Promise<void>;
  forgetFact?(factId: string): Promise<void>;
  /** Negotiated, assignment-scoped project notebook; private facts stay on this assistant. */
  projectMemory?: ProjectMemoryApi;
  projectMemoryProblem?: string;
  cancelSchedule?(scheduleId: string): Promise<void>;
  seeNotices?(): Promise<void>;
  /** Let the assistant run commands on this Mac, in one folder, while Deck is open here. */
  linkThisMac?(folder: string): Promise<void>;
  unlinkMachine?(hostId: string): Promise<void>;
  /** This Mac's host id, when known, to tell whether it's linked. */
  localHostId?: string;
  connectors?(): Promise<ConnectorState[]>;
  /** Save a connector key on the assistant's machine. The value never comes back. */
  saveKey?(name: string, value: string): Promise<void>;
  removeKey?(name: string): Promise<void>;
  browserView?(): Promise<BrowserView>;
  browserTakeOver?(on: boolean): Promise<BrowserView>;
  browserInput?(input: BrowserInput): Promise<BrowserView>;
};
export type ConnectorState = { kind: "github" | "gmail" | "drive" | "browser"; connected: boolean; keys: string[] };
export type BrowserView = { url: string; title: string; image: string; width: number; height: number; takenOver: boolean };
export type BrowserInput = { kind: "click"; x: number; y: number } | { kind: "type"; text: string } | { kind: "key"; key: "Enter" | "Backspace" | "Tab" | "Escape" | "ArrowDown" | "ArrowUp" } | { kind: "scroll"; deltaY: number } | { kind: "navigate"; url: string } | { kind: "back" };
/** One operation the assistant's host hands this Mac to run. */
export type RemoteOp = { taskId: string; opId: string; operation: { tool: string; host: string; cwd: string; argv: string[] } };

export const TASK_STATUS: Record<PersonalTask["status"], string> = {
  needsYou: "Needs you", queued: "Approved", running: "Running", waiting: "Waiting", blocked: "Blocked", done: "Done", failed: "Failed", cancelled: "Cancelled",
};
export const CLASS_LABEL: Record<ToolClass, string> = { read: "Reading", write: "Changing things", send: "Sending to others", spend: "Spending money" };
export const MODE_LABEL: Record<ActionMode, string> = { auto: "Do it without asking", onRequest: "Only when I say so", ask: "Ask first", handOff: "Hand it to me" };

/** A request id the host deduplicates on: a retried send never makes a second message. */
export const requestId = (device: string) => `${device}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The Claude Code profile the slice runs on (D1). Tools stay off on the host. */
export const ASSISTANT_PROFILE = { id: "personal-assistant", display_name: "Assistant", backend: { kind: "agent", tool: "claude_code" } };
export const ASSISTANT_FOLDER = "~/apex-assistant-slice";

type Allow = { hostId: string; assistantId: string; assistantHostId: string; folder: string };
type CommandResult = { exitCode: number; output: string };

/** Lets this Mac run the assistant's commands in one folder. The Mac allows it, then the assistant's host records the link. */
export async function linkThisMacOn({ local, vps, assistantId, assistantHostId, folder, assertOwner = () => {} }: {
  local: Backend; vps: Backend; assistantId: string; assistantHostId: string; folder: string; assertOwner?: () => void;
}): Promise<{ hostId: string; assistant: PersonalAssistantRecord }> {
  assertOwner();
  const allow = await local.call<Allow>("personal_machine_allow", { assistantId, assistantHostId, folder });
  assertOwner();
  const linked = await vps.call<{ assistant: PersonalAssistantRecord }>("personal_machine_link", { assistantId, hostId: allow.hostId, name: "Mac", folder: allow.folder });
  return { hostId: allow.hostId, assistant: linked.assistant };
}

/** One pass: take the operations the host hands this Mac, run each here, and post each result once. */
export async function runMachineBridge({ local, vps, assistantId, assistantHostId, localHostId, assertOwner = () => {}, warn = (message: string) => console.warn(message) }: {
  local: Backend; vps: Backend; assistantId: string; assistantHostId: string; localHostId: string; assertOwner?: () => void; warn?: (message: string) => void;
}): Promise<number> {
  assertOwner();
  const ops = await vps.call<RemoteOp[]>("personal_machine_claim", { assistantId, hostId: localHostId });
  for (const op of ops) {
    assertOwner();
    let outcome: { exitCode: number; output: string } | { error: string };
    try {
      const result = await local.call<CommandResult>("personal_execute_local", { assistantId, assistantHostId, operation: op.operation });
      outcome = { exitCode: result.exitCode, output: result.output };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    assertOwner();
    try {
      await vps.call("personal_machine_result", { assistantId, hostId: localHostId, taskId: op.taskId, opId: op.opId, ...outcome });
    } catch (error) {
      warn(`Could not report a command result to the assistant: ${String(error)}`);
    }
  }
  return ops.length;
}

/** Compatibility view over the single collection; discovery, push and bridges are shared. */
export function usePersonalAssistant(options: PersonalAssistantsOptions): PersonalLane | null {
  const collection = usePersonalAssistants(options);
  return collection.pendingLane() ?? (collection.selected ? collection.lane(collection.selected) : collection.emptyLane());
}
