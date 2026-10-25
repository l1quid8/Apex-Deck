import { useEffect, useRef, useState } from "react";
import { subscribeToImports } from "./legacyImportRefresh.ts";
import type { Backend, HostEntry } from "./backend";
import { assistantIdentityKey, projectIdentityKey, type AssistantRef, type AssistantLook } from "./assistantIdentity.ts";
import { ASSISTANT_FOLDER, ASSISTANT_PROFILE, linkThisMacOn, requestId, runMachineBridge } from "./personalAssistant.ts";
import type { AssistantProjectBinding } from "./assistantIdentity.ts";
import type { PersonalTask } from "./personalAssistant.ts";
import type { PersonalAssistantRecord, PersonalLane, PersonalSettings, ConnectorState, BrowserView, BrowserInput } from "./personalAssistant.ts";
import { unsupported as unsupportedCommand } from "./threadMove.ts";
import { createProjectMemoryClient, PROJECT_MEMORY_CAPABILITY } from "./projectMemory.ts";

export type PersonalAssistantsOptions = {
  hosts: Pick<HostEntry, "id" | "name" | "remote">[];
  hostBackend: (routeHostId: string) => Backend;
  offlineHost: (routeHostId: string) => boolean;
  open?: boolean; device?: string; bridge?: boolean;
  onOpen?: (ref: AssistantRef | null) => void;
  storage?: Pick<Storage, "getItem" | "setItem">;
};
export type PersonalAssistantSummary = {
  ref: AssistantRef; name: string; hostName: string; look?: AssistantLook;
  offline: boolean; revision: number; archivedAt?:number; lastSeen: number; legacy?: PersonalAssistantRecord["legacy"];
  paused: boolean; personalTasks: PersonalTask[]; projects: AssistantProjectBinding[];
  /** Its service is this Mac's, so restarting that service stops its work. */
  onThisMac: boolean; events: NonNullable<PersonalAssistantRecord["events"]>;
};
type HostState = { routeHostId: string; hostId?: string; name: string; state: "ready" | "empty" | "offline" | "unsupported" | "error"; listedAfter?: number; problem?: string };
type Row = { ref: AssistantRef; routeHostId: string; route: Backend; assistant: PersonalAssistantRecord; epoch: number; written: number; lastSeen: number };
const selectionKey = "apex.personal-assistant.selection.v1";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Task tombstones live in a separate protected ledger. Adopt newer derived
 * lifecycle data without letting an equal-revision list replace editor settings. */
function newerAssistant(previous: PersonalAssistantRecord | undefined, next: PersonalAssistantRecord): PersonalAssistantRecord {
  if (!previous) return next;
  if (next.revision < previous.revision) return previous;
  const oldLifecycle = previous.taskLifecycleSnapshotRevision ?? 0, newLifecycle = next.taskLifecycleSnapshotRevision ?? 0;
  if (next.revision === previous.revision && newLifecycle <= oldLifecycle) return previous;
  const base = next.revision > previous.revision ? next : previous;
  const lifecycle = newLifecycle >= oldLifecycle ? next : previous;
  if (base === previous && lifecycle === previous) return previous;
  return { ...base, deletedDelegatedTasks: lifecycle.deletedDelegatedTasks, purgedDelegatedTaskIds: lifecycle.purgedDelegatedTaskIds, taskLifecycleSnapshotRevision: lifecycle.taskLifecycleSnapshotRevision };
}

/** A single store owns all host routes. View selection is never an execution owner. */
export class PersonalAssistantsCollection {
  private options: PersonalAssistantsOptions;
  private rows = new Map<string, Row>();
  private hosts = new Map<string, HostState>();
  private selected: AssistantRef | null = null;
  private saved: AssistantRef | null = null;
  private pendingNotification: AssistantRef | null = null;
  private pendingAfter = 0;
  private listeners = new Set<() => void>();
  private polls = new Map<string, number>();
  private clock = 0;
  private bridges = new Set<string>();
  private pushRegistered = new Set<string>();
  private token?: string;
  private zones = new Set<string>();
  localHostId?: string;

  constructor(options: PersonalAssistantsOptions) {
    this.options = options;
    try {
      const value = this.storage()?.getItem(selectionKey);
      if (value) { const ref = JSON.parse(value); assistantIdentityKey(ref); this.saved = ref; }
    } catch { /* Storage can be disabled. */ }
  }
  update(options: PersonalAssistantsOptions) { this.options = options; }
  private storage() { return this.options.storage ?? (typeof sessionStorage === "undefined" ? undefined : sessionStorage); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  private choose() {
    if (this.pendingNotification) {
      const pending = this.rows.get(assistantIdentityKey(this.pendingNotification));
      if (pending?.assistant.archivedAt!=null) { this.pendingNotification=null; }
      else if (pending) { this.selected = { ...pending.ref }; this.persist(this.selected); this.pendingNotification = null; }
      else {
        const hosts = this.options.hosts.map(host => this.hosts.get(host.id));
        const authoritative = (host: HostState | undefined) => !!host && (host.listedAfter ?? -1) >= this.pendingAfter && (host.state === "ready" || host.state === "empty");
        if (hosts.some(host => authoritative(host) && host?.hostId === this.pendingNotification?.hostId)
          || (hosts.length > 0 && hosts.every(authoritative))) this.pendingNotification = null;
      }
    }
    if (this.selected && this.rows.get(assistantIdentityKey(this.selected))?.assistant.archivedAt==null && this.rows.has(assistantIdentityKey(this.selected))) return;
    const desired = this.saved && this.rows.get(assistantIdentityKey(this.saved));
    this.selected = (desired?.assistant.archivedAt==null?desired?.ref:undefined) ?? [...this.rows.values()].find(row=>row.assistant.archivedAt==null)?.ref ?? null;
    if (this.selected) this.persist(this.selected);
  }
  private persist(ref: AssistantRef) { this.saved = { ...ref }; try { this.storage()?.setItem(selectionKey, JSON.stringify(ref)); } catch { /* Optional session persistence. */ } }
  select = (ref: AssistantRef) => {
    const row = this.rows.get(assistantIdentityKey(ref));
    if (!row || row.assistant.archivedAt!=null) throw new Error("That assistant is removed. Restore it from Archived assistants first.");
    this.pendingNotification = null; this.selected = { ...row.ref }; this.persist(this.selected); this.emit();
  };
  private offline(row: Row) {
    try {
      return !this.options.hosts.some(h => h.id === row.routeHostId) || this.options.offlineHost(row.routeHostId)
        || this.options.hostBackend(row.routeHostId) !== row.route || this.owner(row.route) !== row.ref.hostId
        || this.hosts.get(row.routeHostId)?.state === "error" || this.hosts.get(row.routeHostId)?.state === "unsupported";
    } catch { return true; }
  }
  private summary(row:Row):PersonalAssistantSummary { return {ref:{...row.ref},name:row.assistant.name,legacy:row.assistant.legacy,look:row.assistant.look,revision:row.assistant.revision,archivedAt:row.assistant.archivedAt,hostName:this.hosts.get(row.routeHostId)?.name??row.routeHostId,offline:this.offline(row),paused:!!row.assistant.paused,personalTasks:row.assistant.tasks,projects:row.assistant.projects??[],onThisMac:this.options.hosts.some(h=>h.id===row.routeHostId&&!h.remote),events:row.assistant.events??[],lastSeen:row.lastSeen}; }
  snapshot = () => ({
    assistants: [...this.rows.values()].filter(row=>row.assistant.archivedAt==null).map(row=>this.summary(row)),
    archivedAssistants: [...this.rows.values()].filter(row=>row.assistant.archivedAt!=null).map(row=>this.summary(row)),
    selected: this.selected ? { ...this.selected } : null,
    hosts: [...this.hosts.values()],
    /** This Mac's host id once its service has answered; an assistant elsewhere runs commands here under it. */
    localHostId: this.localHostId,
  });
  /** Only authenticated welcome identity can bind a transport alias such as `local`. */
  private owner(route: Backend): string {
    const status = route.host?.connection.get().status;
    if (status?.kind !== "connected" || !status.hostId || status.hostId === "local") throw new Error("The machine's connected identity is unavailable. Reconnect to verify its owner.");
    return status.hostId;
  }
  private validate(assistant: PersonalAssistantRecord, hostId: string) {
    if (!assistant || assistant.hostId !== hostId || !assistant.id || !Number.isFinite(assistant.revision)) throw new Error("The assistant record does not match the authenticated machine owner identity.");
    assistantIdentityKey({ hostId, assistantId: assistant.id });
  }
  refresh = async () => {
    const options = this.options;
    await Promise.all(options.hosts.map(async host => {
      const ticket = (this.polls.get(host.id) ?? 0) + 1; this.polls.set(host.id, ticket);
      const started = ++this.clock;
      let route: Backend | undefined;
      const current = () => {
        try { return this.polls.get(host.id) === ticket && this.options.hosts.some(h => h.id === host.id) && (!route || this.options.hostBackend(host.id) === route); }
        catch { return false; }
      };
      if (options.offlineHost(host.id)) { this.hosts.set(host.id, { routeHostId: host.id, name: host.name, state: "offline" }); return; }
      try {
        route = options.hostBackend(host.id);
        const connection = route.host?.connection.get().status;
        const ownerAtStart = connection?.kind === "connected" ? connection.hostId : undefined;
        // Calling personal_list may establish the initial connection; read welcome afterward.
        const list = await route.call<PersonalAssistantRecord[]>("personal_list", {});
        if (!current()) return;
        const hostId = this.owner(route);
        if (ownerAtStart && ownerAtStart !== hostId) return;
        if (!Array.isArray(list)) throw new Error("The machine returned an invalid assistant list.");
        list.forEach(assistant => this.validate(assistant, hostId));
        const keys = new Set(list.map(assistant => assistantIdentityKey({ hostId, assistantId: assistant.id })));
        for (const [key, row] of this.rows) if (row.routeHostId === host.id && !keys.has(key) && row.written <= started) this.rows.delete(key);
        for (const assistant of list) {
          const ref = { hostId, assistantId: assistant.id }, key = assistantIdentityKey(ref), old = this.rows.get(key);
          if (old && old.routeHostId !== host.id && !this.offline(old)) continue;
          const rebound = old && (old.route !== route || old.routeHostId !== host.id);
          this.rows.set(key, { ref, routeHostId: host.id, route, assistant: newerAssistant(old?.assistant, assistant), epoch: !rebound && old ? old.epoch : ++this.clock, written: old?.written ?? 0, lastSeen: Date.now() });
        }
        this.hosts.set(host.id, { routeHostId: host.id, hostId, name: host.name, state: list.length ? "ready" : "empty", listedAfter: started });
        if (!host.remote) this.localHostId = hostId;
      } catch (error) {
        if (!current()) return;
        const unsupported = /unknown variant|personal_list.*not supported/i.test(message(error));
        this.hosts.set(host.id, { routeHostId: host.id, name: host.name, state: unsupported ? "unsupported" : "error", problem: unsupported ? "Update this machine's service to use personal assistants." : message(error) });
      }
    }));
    this.choose(); this.emit();
    if (this.token) await this.registerPushToken(this.token);
  };
  private captured(ref: AssistantRef, allowArchived=false) {
    const key = assistantIdentityKey(ref), row = this.rows.get(key);
    if (!row || (!allowArchived && row.assistant.archivedAt!=null)) return null;
    const route = row.route, epoch = row.epoch;
    const need = () => {
      const current = this.rows.get(key);
      if (!current || current.epoch !== epoch || (!allowArchived && current.assistant.archivedAt!=null)) throw new Error("That assistant was removed or is no longer available.");
      if (this.offline(current)) throw new Error("This assistant's machine is offline.");
      if (this.options.hostBackend(row.routeHostId) !== route || this.owner(route) !== row.ref.hostId) throw new Error("This assistant's machine identity changed. Refresh before trying again.");
      return row.ref.assistantId;
    };
    const afterResult = async (cmd: string, args: Record<string, unknown>) => {
      const assistantId = need();
      const result = await route.call<{ assistant: PersonalAssistantRecord; eventId?: string }>(cmd, { ...args, assistantId });
      this.validate(result?.assistant, row.ref.hostId);
      if (result.assistant.id !== assistantId) throw new Error("The host returned a different assistant owner.");
      const current = this.rows.get(key);
      if (current?.epoch === epoch && result.assistant.revision > current.assistant.revision) {
        this.rows.set(key, { ...current, assistant: result.assistant, written: ++this.clock }); this.choose();this.emit();
      }
      return result;
    };
    const after = async (cmd: string, args: Record<string, unknown>) => { await afterResult(cmd, args); };
    return { key, row, route, need, after, afterResult, epoch };
  }
  lane = (ref: AssistantRef): PersonalLane | null => {
    const bound = this.captured(ref); if (!bound) return null;
    const { key, row, route, need, after, afterResult, epoch } = bound;
    const request = () => requestId(this.options.device ?? "mac");
    const call = <T,>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => { need(); return route.call<T>(cmd, args); };
    const attachment = async (work: () => Promise<string>) => { need(); const result = await work(); if (this.rows.get(key)?.epoch !== epoch) throw new Error("The attachment's assistant was removed while saving."); return result; };
    const expectedMemoryRevision = row.assistant.revision;
    const memoryRevision = () => route.supports?.(PROJECT_MEMORY_CAPABILITY) === true ? { expectedRevision: expectedMemoryRevision } : {};
    const projectMemory = route.supports?.(PROJECT_MEMORY_CAPABILITY) !== true ? undefined : createProjectMemoryClient({
      assistant: { ...row.ref }, route, assertAvailable: () => { need(); },
      assertBinding: project => {
        const identity = projectIdentityKey(project);
        if (!this.rows.get(key)?.assistant.projects?.some(binding => projectIdentityKey(binding.project) === identity)) throw new Error("This project is no longer assigned to this assistant. Refresh its projects before reading memory.");
      },
    });
    return {
      ref: { ...row.ref }, draftKey: key, attachmentKey: key,
      name: row.assistant.name, assistant: row.assistant, hostName: this.hosts.get(row.routeHostId)?.name ?? row.routeHostId, offline: this.offline(row), problem: this.hosts.get(row.routeHostId)?.problem,
      send: text => after("personal_send", { requestId: request(), text }),
      sendRequest: route.supports?.("assistant_voice_v1") !== true ? undefined : async (text, requestId) => {
        const result = await afterResult("personal_send", { requestId, text });
        if (!result.eventId) throw new Error("The host did not return the reply identity.");
        return {eventId: result.eventId};
      },
      cancelReply: route.supports?.("assistant_voice_v1") !== true ? undefined : eventId => after("personal_reply_cancel", {requestId: request(), eventId}),
      taskLifecycle: route.supports?.("assistant_task_lifecycle_v1") !== true ? undefined : (action, task, expectedDeleted) => after("personal_task_lifecycle", {expectedRevision: row.assistant.revision, action, task: task ? {source: task.source, taskId: task.taskId, ...(task.revision == null ? {} : {revision: task.revision})} : undefined, expectedDeleted}),
      archiveAssistant: route.supports?.("assistant_archive_v1")!==true?undefined:async expectedRevision=>{
        if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new Error("Archive requires the saved assistant revision.");
        const result=await afterResult("personal_archive",{expectedRevision,archived:true});
        if(result.assistant.archivedAt==null||!Number.isSafeInteger(result.assistant.archivedAt)||result.assistant.revision<=expectedRevision)throw new Error("The host did not confirm saved assistant removal. Refresh before trying again.");
      },
      react: async (messageId, emoji, enabled) => {
        try { await after("personal_react", { messageId, emoji, enabled }); }
        catch (error) { if (unsupportedCommand(error, "personal_react")) throw new Error("This host does not support saved assistant reactions. Update its service to use reactions here."); throw error; }
      },
      saveAttachment: (name, bytes) => attachment(() => route.saveAttachment(need(), name, bytes)),
      pickFolder: async () => { need(); const path = await route.pickFolder(); if (!path) return null; return attachment(() => route.copyAttachment(need(), path)); },
      decide: (decisionId, paramsHash, approve) => after("personal_decide", { requestId: request(), decisionId, paramsHash, approve }),
      cancel: taskId => after("personal_cancel", { requestId: request(), taskId }),
      pause: paused => after("personal_pause", { requestId: request(), paused }),
      configure: settings => { this.legacySettings(settings); return after("personal_configure", { settings }); },
      configureWorkspace: route.supports?.("assistant_workspace_v4") !== true ? undefined : configuration => {
        if (route.supports?.("assistant_workspace_v4") !== true) throw new Error("This machine no longer supports workspace settings. Reconnect and refresh.");
        if (!Number.isSafeInteger(configuration.expectedRevision) || configuration.expectedRevision < 0) throw new Error("Workspace settings require the editor's saved revision.");
        return afterResult("personal_workspace_configure", { ...configuration }).then(result=>result.assistant);
      },
      addRule: (text, cls, mode) => after("personal_rule_add", { text, class: cls, mode }),
      removeRule: ruleId => after("personal_rule_remove", { ruleId }),
      remember: text => after("personal_memory_add", { text, ...memoryRevision() }),
      correctFact: (factId, text) => after("personal_memory_correct", { factId, text, ...memoryRevision() }),
      forgetFact: factId => after("personal_memory_forget", { factId, ...memoryRevision() }),
      projectMemory, projectMemoryProblem: projectMemory ? undefined : "Update this machine's service to inspect and edit shared project memory.",
      cancelSchedule: scheduleId => after("personal_schedule_cancel", { requestId: request(), scheduleId }),
      seeNotices: () => after("personal_notices_seen", { upTo: Date.now() }),
      localHostId: this.localHostId,
      linkThisMac: async folder => {
        need(); const mac = this.options.hosts.find(h => !h.remote); if (!mac || this.options.offlineHost(mac.id)) throw new Error("This Mac's Deck isn't running.");
        const local = this.options.hostBackend(mac.id), localId = this.owner(local);
        const assertOwner = () => {
          need();
          if (this.options.hostBackend(mac.id) !== local || this.owner(local) !== localId || this.options.offlineHost(mac.id)) throw new Error("This Mac's identity changed while linking.");
        };
        const linked = await linkThisMacOn({ local, vps: route, assistantId: need(), assistantHostId: row.ref.hostId, folder, assertOwner });
        this.localHostId = linked.hostId;
        this.validate(linked.assistant, row.ref.hostId);
        if (linked.assistant.id !== row.ref.assistantId) throw new Error("The machine link returned a different assistant.");
        const current = this.rows.get(key);
        if (current?.epoch === epoch && linked.assistant.revision > current.assistant.revision) this.rows.set(key, { ...current, assistant: linked.assistant, written: ++this.clock });
        this.emit();
      },
      unlinkMachine: hostId => after("personal_machine_unlink", { hostId }),
      connectors: () => call<ConnectorState[]>("personal_connectors"),
      saveKey: async (name, value) => { await call("api_key_save", { name, key: value }); },
      removeKey: async name => { await call("api_key_remove", { name }); },
      browserView: () => call<BrowserView>("personal_browser_view"),
      browserTakeOver: on => call<BrowserView>("personal_browser_take_over", { on }),
      browserInput: (input: BrowserInput) => call<BrowserView>("personal_browser_input", { input }),
    };
  };
  /** Legacy configure denies unknown fields. V4 runtime/projects require negotiated support and its separate API. */
  private legacySettings(settings: Partial<PersonalSettings>) {
    const fields = new Set(["name", "style", "look", "timezone", "quietHours", "modes", "budget", "privacy", "contextBudgetChars", "utcOffsetMinutes"]);
    if (Object.keys(settings).some(key => !fields.has(key))) throw new Error("Update this host and use supported workspace configuration to change runtime or projects.");
    if (settings.look && Object.keys(settings.look).some(key => key !== "color" && key !== "shape")) throw new Error("This host's legacy settings cannot save extended assistant appearance. Workspace configuration support is required.");
  }
  /** Captures the authenticated host before any creation await. Never follows selection. */
  create = async (routeHostId: string, input: import('./AssistantWorkspace').AssistantCreation): Promise<AssistantRef> => {
    if (this.options.offlineHost(routeHostId)) throw new Error("This machine is offline.");
    const route = this.options.hostBackend(routeHostId), hostId = this.owner(route);
    if (route.supports?.('assistant_workspace_v4') !== true) throw new Error("Update this machine’s service to create workspace assistants.");
    const assistant = await route.call<PersonalAssistantRecord>('personal_create', input);
    if (this.options.hostBackend(routeHostId) !== route || this.owner(route) !== hostId) throw new Error("The machine identity changed during creation. Refresh this machine before continuing.");
    this.validate(assistant, hostId);
    const ref = {hostId, assistantId:assistant.id}, key = assistantIdentityKey(ref);
    this.rows.set(key, {ref,routeHostId,route,assistant,epoch:++this.clock,written:this.clock,lastSeen:Date.now()});
    this.select(ref); return ref;
  };
  emptyLane = (): PersonalLane | null => {
    const host = [...this.hosts.values()].find(h => h.state === "empty") ?? [...this.hosts.values()][0];
    if (!host) return null;
    const unavailable = async (): Promise<never> => { throw new Error(host.problem ?? "Set up an assistant first."); };
    return { name: "Assistant", hostName: host.name, assistant: null, offline: host.state === "offline", problem: host.problem,
      send: unavailable, react: unavailable, saveAttachment: unavailable, pickFolder: unavailable, decide: unavailable, cancel: unavailable,
      setUp: host.state !== "empty" ? undefined : async () => {
        if (this.options.offlineHost(host.routeHostId)) throw new Error("This machine is offline.");
        const route = this.options.hostBackend(host.routeHostId), hostId = this.owner(route);
        const assistant = await route.call<PersonalAssistantRecord>("personal_create", { name: "Assistant", folder: ASSISTANT_FOLDER, profile: ASSISTANT_PROFILE });
        this.validate(assistant, hostId);
        const ref = { hostId, assistantId: assistant.id }, key = assistantIdentityKey(ref);
        this.rows.set(key, { ref, routeHostId: host.routeHostId, route, assistant, epoch: ++this.clock, written: this.clock, lastSeen: Date.now() });
        this.select(ref);
      } };
  };
  restoreAssistant = async (ref:AssistantRef,expectedRevision:number):Promise<void> => {
    const bound=this.captured(ref,true);
    if(!bound || bound.row.assistant.archivedAt==null)throw new Error("This assistant is not archived. Refresh the assistant list.");
    if(bound.route.supports?.("assistant_archive_v1")!==true)throw new Error("Update this machine’s service to restore assistants.");
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new Error("Restore requires the saved assistant revision.");
    const result=await bound.afterResult("personal_archive",{expectedRevision,archived:false});
    if(result.assistant.archivedAt!=null||result.assistant.revision<=expectedRevision)throw new Error("The host did not confirm restoration. Refresh and try again.");
  };
  bridge = async () => {
    const local = this.options.hosts.find(h => !h.remote);
    if (!local || this.options.offlineHost(local.id)) return;
    const localRoute = this.options.hostBackend(local.id);
    let localId: string;
    try { localId = this.owner(localRoute); this.localHostId = localId; } catch { return; }
    await Promise.all([...this.rows.values()].map(async row => {
      const key = assistantIdentityKey(row.ref);
      if (row.assistant.archivedAt!=null || this.bridges.has(key) || this.offline(row) || !row.assistant.machines?.some(m => m.hostId === localId)) return;
      const bound = this.captured(row.ref); if (!bound) return;
      this.bridges.add(key);
      try {
        const assertOwner = () => {
          bound.need();
          if (this.options.hostBackend(local.id) !== localRoute || this.owner(localRoute) !== localId || this.options.offlineHost(local.id)) throw new Error("This Mac's identity changed during a command.");
        };
        await runMachineBridge({ local: localRoute, vps: bound.route, assistantId: row.ref.assistantId, assistantHostId: row.ref.hostId, localHostId: localId, assertOwner });
      }
      catch (error) { console.warn(`Machine bridge: ${message(error)}`); }
      finally { this.bridges.delete(key); }
    }));
  };
  registerPushToken = async (token: string) => {
    this.token = token;
    await Promise.all([...this.rows.values()].map(async row => {
      const key = JSON.stringify([assistantIdentityKey(row.ref), token]);
      if (row.assistant.archivedAt!=null || this.pushRegistered.has(key) || this.offline(row)) return;
      const bound = this.captured(row.ref); if (!bound) return;
      this.pushRegistered.add(key);
      try { await bound.route.call("personal_push_register", { assistantId: bound.need(), token }); }
      catch { this.pushRegistered.delete(key); }
    }));
  };
  openNotification = (data: unknown): AssistantRef | null => {
    const info = (data as { notification?: { data?: { hostId?: string; assistantId?: string } } })?.notification?.data;
    let ref: AssistantRef | null = null;
    if (typeof info?.hostId === "string" && typeof info.assistantId === "string") {
      try {
        const candidate = { hostId: info.hostId, assistantId: info.assistantId };
        const row = this.rows.get(assistantIdentityKey(candidate));
        if (row?.assistant.archivedAt!=null) { this.pendingNotification=null; }
        else if (row) { ref = { ...row.ref }; this.select(ref); }
        else { this.pendingNotification = candidate; this.pendingAfter = ++this.clock; this.emit(); }
      } catch { /* Malformed notifications open the current safe view. */ }
    }
    // Legacy notifications have no host owner; opening the current safe view never guesses by id.
    this.options.onOpen?.(ref); return ref;
  };
  /** A notification for an unseen identity never presents another assistant as its writable destination. */
  pendingLane = (): PersonalLane | null => {
    const ref = this.pendingNotification;
    if (!ref) return null;
    const problem = "Waiting for the assistant from this notification. Its machine has not confirmed this identity yet.";
    const unavailable = async (): Promise<never> => { throw new Error(problem); };
    return { ref: { ...ref }, draftKey: assistantIdentityKey(ref), attachmentKey: assistantIdentityKey(ref), name: "Assistant", hostName: [...this.hosts.values()].find(host => host.hostId === ref.hostId)?.name ?? ref.hostId,
      assistant: null, offline: true, problem, send: unavailable, react: unavailable, saveAttachment: unavailable, pickFolder: unavailable, decide: unavailable, cancel: unavailable };
  };
  syncTimezones = async () => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, utcOffsetMinutes = -new Date().getTimezoneOffset();
    if (timezone === "UTC") return;
    await Promise.all([...this.rows.values()].map(async row => {
      const key = assistantIdentityKey(row.ref);
      if (row.assistant.archivedAt!=null || this.zones.has(key) || this.offline(row) || (row.assistant.utcOffsetMinutes === utcOffsetMinutes && row.assistant.timezone !== "UTC")) return;
      this.zones.add(key);
      try { await this.lane(row.ref)?.configure?.({ timezone, utcOffsetMinutes }); } catch { /* Best effort, as before. */ }
    }));
  };
}

type PushPlugin = {
  requestPermissions(): Promise<{ receive: string }>; register(): Promise<void>;
  addListener(event: string, callback: (data: unknown) => void): Promise<{ remove(): Promise<void> | void }>;
};
export function usePersonalAssistants(options: PersonalAssistantsOptions) {
  const store = useRef<PersonalAssistantsCollection | null>(null);
  if (!store.current) store.current = new PersonalAssistantsCollection(options);
  const collection = store.current; collection.update(options);
  const [, render] = useState(0);
  useEffect(() => collection.subscribe(() => render(value => value + 1)), [collection]);
  const hostKey = JSON.stringify(options.hosts.map(h => [h.id, h.name, h.remote]));
  useEffect(() => {
    const refresh = async () => { await collection.refresh(); await collection.syncTimezones(); };
    void refresh(); const timer = setInterval(() => void refresh(), 2500);
    const stopImports = subscribeToImports(() => { void refresh(); });
    return () => { stopImports(); clearInterval(timer); };
  }, [collection, hostKey]);
  useEffect(() => {
    if (!options.bridge) return;
    const timer = setInterval(() => void collection.bridge(), 5000); return () => clearInterval(timer);
  }, [collection, options.bridge]);
  const snapshot = collection.snapshot();
  const pushStarted = useRef(false);
  useEffect(() => {
    if (options.device !== "phone") return;
    const plugin = (globalThis as unknown as { Capacitor?: { Plugins?: { PushNotifications?: PushPlugin } } }).Capacitor?.Plugins?.PushNotifications;
    if (!plugin) return;
    const handles = [plugin.addListener("registration", data => {
      const token = (data as { value?: string }).value; if (token) void collection.registerPushToken(token);
    }), plugin.addListener("pushNotificationActionPerformed", collection.openNotification)];
    return () => { for (const handle of handles) void handle.then(h => h.remove()).catch(() => undefined); };
  }, [collection, options.device]);
  useEffect(() => {
    if (options.device !== "phone" || !snapshot.assistants.length || pushStarted.current) return;
    const plugin = (globalThis as unknown as { Capacitor?: { Plugins?: { PushNotifications?: PushPlugin } } }).Capacitor?.Plugins?.PushNotifications;
    if (!plugin) return;
    pushStarted.current = true;
    void plugin.requestPermissions().then(permission => permission.receive === "granted" ? plugin.register() : undefined).catch(error => console.warn(`Notifications: ${message(error)}`));
  }, [options.device, snapshot.assistants.length]);
  return { ...snapshot, select: collection.select, lane: collection.lane, refresh: collection.refresh, create: collection.create, restoreAssistant: collection.restoreAssistant, emptyLane: collection.emptyLane, pendingLane: collection.pendingLane };
}
