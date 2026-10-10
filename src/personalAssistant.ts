// The personal assistant lives on a durable host (the VPS). Clients only
// read its record and send it events; the host owns every task, approval
// and receipt (crates/apex-host/src/personal.rs).

import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend, HostEntry } from "./backend";

export type PersonalMessage = { id: string; role: "human" | "assistant" | "system"; kind: "chat" | "approval" | "result" | "update"; text: string; at: number; taskId?: string; eventId?: string };
export type PersonalDecision = { id: string; kind: "approve" | "uncertain"; paramsHash: string; prompt: string; status: "open" | "approved" | "denied" | "superseded"; openedAt: number };
export type PersonalReceipt = { opId: string; phase: "attempted" | "verified" | "failed" | "uncertain"; exitCode?: number; outputExcerpt: string; rerunAfterRestart: boolean; note?: string; startedAt: number; finishedAt?: number };
export type PersonalTask = {
  id: string; goal: string; completionCriteria: string[]; targetHost: string;
  status: "needsYou" | "queued" | "running" | "done" | "failed" | "cancelled";
  operation?: { tool: string; host: string; cwd: string; argv: string[] };
  decision?: PersonalDecision; receipts: PersonalReceipt[]; lastUpdate?: string; updatedAt: number;
};
export type PersonalAssistantRecord = { id: string; name: string; hostId: string; allowedFolders: string[]; revision: number; messages: PersonalMessage[]; tasks: PersonalTask[] };

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
};

export const TASK_STATUS: Record<PersonalTask["status"], string> = {
  needsYou: "Needs you", queued: "Approved", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled",
};

/** A request id the host deduplicates on: a retried send never makes a second message. */
export const requestId = (device: string) => `${device}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The Claude Code profile the slice runs on (D1). Tools stay off on the host. */
export const ASSISTANT_PROFILE = { id: "personal-assistant", display_name: "Assistant", backend: { kind: "agent", tool: "claude_code" } };
export const ASSISTANT_FOLDER = "~/apex-assistant-slice";

const unsupported = (error: unknown) => /unknown variant|personal_list/i.test(String(error instanceof Error ? error.message : error));

/** Find the assistant on the first remote host that has one, and keep it fresh while the conversation is open. */
export function usePersonalAssistant({ hosts, hostBackend, offlineHost, open, device = "mac" }: {
  hosts: Pick<HostEntry, "id" | "name" | "remote">[]; hostBackend: (hostId: string) => Backend; offlineHost: (hostId: string) => boolean; open: boolean; device?: string;
}): PersonalLane | null {
  const remote = hosts.filter((host) => host.remote);
  const [found, setFound] = useState<{ hostId: string; assistant: PersonalAssistantRecord | null; problem?: string } | null>(null);
  const generation = useRef(0);
  const hostKey = remote.map((host) => host.id).join("|");
  // App passes new functions every render; the poll reads the latest ones.
  const latest = useRef({ remote, hostBackend, offlineHost });
  latest.current = { remote, hostBackend, offlineHost };
  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const { remote, hostBackend } = latest.current;
    let fallback: { hostId: string; assistant: null; problem?: string } | null = null;
    for (const host of remote) {
      try {
        const list = await hostBackend(host.id).call<PersonalAssistantRecord[]>("personal_list", {});
        if (mine !== generation.current) return;
        if (list.length) { setFound({ hostId: host.id, assistant: list[0] }); return; }
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
  };
}
