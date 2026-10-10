// The personal assistant lives on a durable host (the VPS). Clients only
// read its record and send it events; the host owns every task, approval
// and receipt (crates/apex-host/src/personal.rs).

import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend, HostEntry } from "./backend";

export type PersonalMessage = { id: string; role: "human" | "assistant" | "system"; kind: "chat" | "approval" | "result" | "update" | "helper" | "notice"; text: string; at: number; taskId?: string; eventId?: string };
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
};
export type Schedule = { id: string; goal: string; argv: string[]; everyMs?: number; dailyAt?: string; nextAt?: number; status: "proposed" | "active" | "cancelled"; createdAt: number; lastTaskId?: string; runs: number; paramsHash: string; decision?: PersonalDecision };
export type Notice = { id: string; text: string; taskId?: string; urgent: boolean; at: number; deliverAt: number; deliveredAt?: number; seenAt?: number; fingerprint: string };
export type CostEntry = { at: number; purpose: "reply" | "helper" | "summary" | "check"; kind: "text" | "image" | "audio" | "video" | "tool"; source: "reported" | "estimated" | "unknown"; micros?: number; inputTokens?: number; outputTokens?: number; bytesOut: number; endpoint: string };
export type StandingRule = { id: string; text: string; class: ToolClass; mode: ActionMode; createdAt: number };
export type PersonalSettings = {
  name: string; style: string; look?: { color?: string; shape?: string };
  timezone: string; quietHours?: { start: string; end: string };
  modes: Record<ToolClass, ActionMode>;
  budget: { dailyLimitMicros?: number; unknownCostOk?: boolean };
  privacy: { localOnly: boolean; allowedEndpoints: string[] };
  contextBudgetChars: number;
  utcOffsetMinutes?: number;
};
export type PersonalAssistantRecord = PersonalSettings & {
  id: string; hostId: string; allowedFolders: string[]; paused?: boolean; revision: number;
  messages: PersonalMessage[]; tasks: PersonalTask[];
  rules?: StandingRule[]; facts?: Fact[]; schedules?: Schedule[]; notices?: Notice[]; costs?: CostEntry[];
  machines?: { hostId: string; name: string; folder: string; lastSeen?: number }[];
};

/** What the ApexAgent conversation needs to show and talk to the personal assistant. */
export type PersonalLane = {
  name: string;
  hostName: string;
  assistant: PersonalAssistantRecord | null;
  offline: boolean;
  /** Why the lane can't be used, such as an older service. */
  problem?: string;
  setUp?: () => Promise<void>;
  send(text: string): Promise<void>;
  decide(decisionId: string, paramsHash: string, approve: boolean): Promise<void>;
  cancel(taskId: string): Promise<void>;
  /** Pause stops new work starting; the assistant keeps answering. */
  pause?(paused: boolean): Promise<void>;
  /** Change name, style, modes, quiet hours, budget or privacy. Only what's given changes. */
  configure?(settings: Partial<PersonalSettings>): Promise<void>;
  addRule?(text: string, cls: ToolClass, mode: ActionMode): Promise<void>;
  removeRule?(ruleId: string): Promise<void>;
  remember?(text: string): Promise<void>;
  correctFact?(factId: string, text: string): Promise<void>;
  forgetFact?(factId: string): Promise<void>;
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

type PushPlugin = {
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(event: string, callback: (data: unknown) => void): Promise<{ remove(): Promise<void> | void }>;
};
/** The Capacitor push plugin, present only inside the phone app. */
const pushPlugin = (device: string): PushPlugin | undefined => {
  if (device !== "phone") return undefined;
  return (globalThis as unknown as { Capacitor?: { Plugins?: { PushNotifications?: PushPlugin } } }).Capacitor?.Plugins?.PushNotifications;
};

const unsupported = (error: unknown) => /unknown variant|personal_list/i.test(String(error instanceof Error ? error.message : error));

type Allow = { hostId: string; assistantId: string; assistantHostId: string; folder: string };
type CommandResult = { exitCode: number; output: string };

/** Lets this Mac run the assistant's commands in one folder. The Mac allows it, then the assistant's host records the link. */
export async function linkThisMacOn({ local, vps, assistantId, assistantHostId, folder }: {
  local: Backend; vps: Backend; assistantId: string; assistantHostId: string; folder: string;
}): Promise<{ hostId: string; assistant: PersonalAssistantRecord }> {
  const allow = await local.call<Allow>("personal_machine_allow", { assistantId, assistantHostId, folder });
  const linked = await vps.call<{ assistant: PersonalAssistantRecord }>("personal_machine_link", { assistantId, hostId: allow.hostId, name: "Mac", folder: allow.folder });
  return { hostId: allow.hostId, assistant: linked.assistant };
}

/** One pass: take the operations the host hands this Mac, run each here, and post each result once. */
export async function runMachineBridge({ local, vps, assistantId, assistantHostId, localHostId, warn = (message: string) => console.warn(message) }: {
  local: Backend; vps: Backend; assistantId: string; assistantHostId: string; localHostId: string; warn?: (message: string) => void;
}): Promise<number> {
  const ops = await vps.call<RemoteOp[]>("personal_machine_claim", { assistantId, hostId: localHostId });
  for (const op of ops) {
    let outcome: { exitCode: number; output: string } | { error: string };
    try {
      const result = await local.call<CommandResult>("personal_execute_local", { assistantId, assistantHostId, operation: op.operation });
      outcome = { exitCode: result.exitCode, output: result.output };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    try {
      await vps.call("personal_machine_result", { assistantId, hostId: localHostId, taskId: op.taskId, opId: op.opId, ...outcome });
    } catch (error) {
      warn(`Could not report a command result to the assistant: ${String(error)}`);
    }
  }
  return ops.length;
}

/** Find the assistant on the first remote host that has one, and keep it fresh while the conversation is open.
 *  With `bridge` (the Mac), also run the commands the assistant hands this Mac, whether or not the popup is open. */
export function usePersonalAssistant({ hosts, hostBackend, offlineHost, open, device = "mac", bridge = false, onOpen }: {
  hosts: Pick<HostEntry, "id" | "name" | "remote">[]; hostBackend: (hostId: string) => Backend; offlineHost: (hostId: string) => boolean; open: boolean; device?: string; bridge?: boolean;
  /** The phone: a tap on an assistant notification opens the assistant. */
  onOpen?: () => void;
}): PersonalLane | null {
  const remote = hosts.filter((host) => host.remote);
  const local = hosts.find((host) => !host.remote);
  const [found, setFound] = useState<{ hostId: string; assistant: PersonalAssistantRecord | null; problem?: string } | null>(null);
  const [localHostId, setLocalHostId] = useState<string | undefined>(undefined);
  const generation = useRef(0);
  const hostKey = remote.map((host) => host.id).join("|");
  const localKey = local?.id ?? "";
  // App passes new functions every render; the poll reads the latest ones.
  const latest = useRef({ remote, hostBackend, offlineHost, hosts });
  latest.current = { remote, hostBackend, offlineHost, hosts };
  const latestFound = useRef(found);
  latestFound.current = found;
  const latestLocalId = useRef(localHostId);
  latestLocalId.current = localHostId;
  const bridgeBusy = useRef(false);
  // The host stores the zone it was given; a fresh or UTC record is corrected once per mount, errors ignored.
  const zoneSynced = useRef(false);
  const syncZone = (hostId: string, assistant: PersonalAssistantRecord) => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offset = -new Date().getTimezoneOffset();
    if (zoneSynced.current || zone === "UTC") return;
    if (assistant.utcOffsetMinutes === offset && assistant.timezone !== "UTC") return;
    zoneSynced.current = true;
    latest.current.hostBackend(hostId).call<{ assistant: PersonalAssistantRecord }>("personal_configure", { assistantId: assistant.id, settings: { timezone: zone, utcOffsetMinutes: offset } })
      .then((result) => { if (result?.assistant) setFound({ hostId, assistant: result.assistant }); })
      .catch(() => {});
  };
  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const { remote, hostBackend } = latest.current;
    let fallback: { hostId: string; assistant: null; problem?: string } | null = null;
    for (const host of remote) {
      try {
        const list = await hostBackend(host.id).call<PersonalAssistantRecord[]>("personal_list", {});
        if (mine !== generation.current) return;
        if (list.length) { setFound({ hostId: host.id, assistant: list[0] }); syncZone(host.id, list[0]); return; }
        fallback ??= { hostId: host.id, assistant: null };
      } catch (error) {
        if (mine !== generation.current) return;
        fallback ??= { hostId: host.id, assistant: null, problem: unsupported(error) ? "This machine's service is too old for the personal assistant. Update it first." : String(error instanceof Error ? error.message : error) };
      }
    }
    if (mine === generation.current) setFound(fallback);
  }, []);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [open, refresh, hostKey]);
  // On the Mac: learn this Mac's host id from the allowances it already has, once.
  useEffect(() => {
    if (!bridge || !localKey) return;
    let cancelled = false;
    latest.current.hostBackend(localKey).call<{ allows: { hostId: string }[] }>("personal_machine_allowed", {})
      .then((result) => { const first = result?.allows?.[0]; if (first && !cancelled) setLocalHostId(first.hostId); })
      .catch((error) => console.warn(`Could not read this Mac's links: ${String(error)}`));
    return () => { cancelled = true; };
  }, [bridge, localKey]);
  // The phone: push notifications for the assistant. Asked once per mount; the token goes to the assistant's host.
  const pushStarted = useRef(false);
  const latestOpen = useRef(onOpen);
  latestOpen.current = onOpen;
  const assistantKey = found?.assistant?.id ?? "";
  useEffect(() => {
    const plugin = pushPlugin(device);
    if (!plugin) return;
    const handles: Promise<{ remove(): Promise<void> | void }>[] = [
      plugin.addListener("registration", (data) => {
        const token = (data as { value?: string }).value;
        const current = latestFound.current;
        if (!token || !current?.assistant) return;
        latest.current.hostBackend(current.hostId).call("personal_push_register", { assistantId: current.assistant.id, token }).catch(() => undefined);
      }),
      plugin.addListener("pushNotificationActionPerformed", () => latestOpen.current?.()),
    ];
    return () => { for (const handle of handles) void handle.then((item) => item.remove()).catch(() => undefined); };
  }, [device]);
  useEffect(() => {
    const plugin = pushPlugin(device);
    if (!plugin || !assistantKey || pushStarted.current) return;
    pushStarted.current = true;
    void (async () => {
      try {
        const permission = await plugin.requestPermissions();
        if (permission.receive === "granted") await plugin.register();
      } catch (error) {
        console.warn(`Notifications: ${String(error)}`);
      }
    })();
  }, [device, assistantKey]);
  // Every 5 s on the Mac, whether or not the conversation is open: run what the assistant hands this Mac.
  useEffect(() => {
    if (!bridge) return;
    const tick = async () => {
      const current = latestFound.current;
      const mac = latestLocalId.current;
      const mine = latest.current.hosts.find((host) => !host.remote);
      if (bridgeBusy.current || !mac || !mine || !current?.assistant) return;
      if (!current.assistant.machines?.some((machine) => machine.hostId === mac)) return;
      if (latest.current.offlineHost(current.hostId)) return;
      bridgeBusy.current = true;
      try {
        await runMachineBridge({
          local: latest.current.hostBackend(mine.id), vps: latest.current.hostBackend(current.hostId),
          assistantId: current.assistant.id, assistantHostId: current.hostId, localHostId: mac,
        });
      } catch (error) {
        console.warn(`Machine bridge: ${String(error)}`);
      } finally {
        bridgeBusy.current = false;
      }
    };
    const timer = setInterval(() => void tick(), 5000);
    return () => clearInterval(timer);
  }, [bridge]);
  if (!found) return null;
  const host = remote.find((item) => item.id === found.hostId);
  if (!host) return null;
  const route = () => hostBackend(host.id);
  const id = found.assistant?.id;
  const after = async (work: Promise<{ assistant: PersonalAssistantRecord }>) => {
    const { assistant } = await work;
    setFound({ hostId: host.id, assistant });
  };
  const need = () => { if (!id) throw new Error("Set up the assistant first."); return id; };
  return {
    name: found.assistant?.name ?? "Assistant",
    hostName: host.name,
    assistant: found.assistant,
    offline: offlineHost(host.id),
    problem: found.problem,
    setUp: found.assistant || found.problem ? undefined : async () => {
      const assistant = await route().call<PersonalAssistantRecord>("personal_create", { name: "Assistant", folder: ASSISTANT_FOLDER, profile: ASSISTANT_PROFILE });
      setFound({ hostId: host.id, assistant });
    },
    send: (text) => after(route().call("personal_send", { assistantId: need(), requestId: requestId(device), text })),
    decide: (decisionId, paramsHash, approve) => after(route().call("personal_decide", { assistantId: need(), requestId: requestId(device), decisionId, paramsHash, approve })),
    cancel: (taskId) => after(route().call("personal_cancel", { assistantId: need(), requestId: requestId(device), taskId })),
    pause: (paused) => after(route().call("personal_pause", { assistantId: need(), requestId: requestId(device), paused })),
    configure: (settings) => after(route().call("personal_configure", { assistantId: need(), settings })),
    addRule: (text, cls, mode) => after(route().call("personal_rule_add", { assistantId: need(), text, class: cls, mode })),
    removeRule: (ruleId) => after(route().call("personal_rule_remove", { assistantId: need(), ruleId })),
    remember: (text) => after(route().call("personal_memory_add", { assistantId: need(), text })),
    correctFact: (factId, text) => after(route().call("personal_memory_correct", { assistantId: need(), factId, text })),
    forgetFact: (factId) => after(route().call("personal_memory_forget", { assistantId: need(), factId })),
    cancelSchedule: (scheduleId) => after(route().call("personal_schedule_cancel", { assistantId: need(), requestId: requestId(device), scheduleId })),
    seeNotices: () => after(route().call("personal_notices_seen", { assistantId: need(), upTo: Date.now() })),
    localHostId,
    linkThisMac: async (folder) => {
      const mine = latest.current.hosts.find((item) => !item.remote);
      if (!mine) throw new Error("This Mac's Deck isn't running.");
      const linked = await linkThisMacOn({ local: latest.current.hostBackend(mine.id), vps: route(), assistantId: need(), assistantHostId: host.id, folder });
      setLocalHostId(linked.hostId);
      setFound({ hostId: host.id, assistant: linked.assistant });
    },
    unlinkMachine: (hostId) => after(route().call("personal_machine_unlink", { assistantId: need(), hostId })),
    connectors: () => route().call<ConnectorState[]>("personal_connectors", {}),
    saveKey: async (name, value) => { await route().call("api_key_save", { name, key: value }); },
    removeKey: async (name) => { await route().call("api_key_remove", { name }); },
    browserView: () => route().call<BrowserView>("personal_browser_view", {}),
    browserTakeOver: (on) => route().call<BrowserView>("personal_browser_take_over", { on }),
    browserInput: (input) => route().call<BrowserView>("personal_browser_input", { input }),
  };
}
