import { useEffect, useState } from "react";
import { ChevronRight, Settings } from "./icons";
import { AssistantCreationDialog } from "../AssistantCreationDialog";
import { AssistantEditor } from "../AssistantEditor";
import { prefillAssistantComposer } from "../assistantComposerDrafts";
import { assistantIdentityKey, type AssistantRef } from "../assistantIdentity";
import { splitFirstBrief } from "../assistantWorkspaceModel";
import type { PhoneHost } from "../phoneBackend";
import type { ProjectMonitor } from "../apexAgentModel";
import type { ParticipantConfig, Workspace } from "../types";
import type { usePersonalAssistants } from "../usePersonalAssistants";
import "../assistant-workspace.css";

type Collection = ReturnType<typeof usePersonalAssistants>;
type EditorTarget = { routeId: string; hostId: string; assistant?: AssistantRef };
const emptyProfiles: ParticipantConfig[] = [];

export function PhoneAssistantRoster({ collection, hosts, onOpen }: {
  collection: Collection;
  hosts: PhoneHost[];
  onOpen(): void;
}) {
  const [target, setTarget] = useState<EditorTarget | null>(null);
  const route = collection.hosts.find(h => h.routeHostId === target?.routeId && h.hostId === target?.hostId);
  const backend = hosts.find(h => h.machine.id === route?.routeHostId)?.backend;
  const [snapshot, setSnapshot] = useState<{ backend: typeof backend; profiles: ParticipantConfig[]; projects: Workspace[] }>();
  const [problem, setProblem] = useState("");
  const [restoreError, setRestoreError] = useState("");
  useEffect(() => {
    let active = true;
    setProblem("");
    if (backend && target) {
      const owner = target.hostId;
      void Promise.all([backend.sessionLoad(), backend.call<ProjectMonitor[]>("monitor_list")])
        .then(([session, monitors]) => {
          if (!active) return;
          const owned = (session?.workspaces ?? []).filter(p => !p.hostId || p.hostId === "local" || p.hostId === owner);
          const projects = owned.filter(p => !p.hidden);
          for (const monitor of monitors) {
            if (monitor.hostId !== owner && monitor.hostId !== "local") continue;
            if (owned.some(p => p.id === monitor.workspaceId)) continue;
            projects.push({ id: monitor.workspaceId, name: monitor.cwd.split(/[/\\]/).filter(Boolean).pop() ?? monitor.cwd, path: monitor.cwd, hostId: owner });
          }
          setSnapshot({ backend, profiles: session?.profiles ?? emptyProfiles, projects });
        }).catch(error => { if (active) setProblem(String(error)); });
    }
    return () => { active = false; };
  }, [backend, target]);
  const open = (ref: AssistantRef) => { collection.select(ref); setTarget(null); onOpen(); };
  const editing = target?.assistant ? collection.lane(target.assistant) : null;
  const available = route?.state === "ready" || route?.state === "empty";
  return <>
    <div className="ph-section">Your assistants</div>
    <div className="ph-list">
      {collection.assistants.map(row => {
        const home = collection.hosts.find(h => h.hostId === row.ref.hostId);
        const waiting = row.personalTasks.filter(t => t.status === "needsYou" && t.decision?.status === "open").length;
        const unseen = collection.lane(row.ref)?.assistant?.notices?.filter(n => n.deliveredAt && !n.seenAt).length ?? 0;
        const needed = waiting + unseen;
        return <div className="ph-assistant-row" key={assistantIdentityKey(row.ref)}>
          <button type="button" className="ph-srow" disabled={row.offline} onClick={() => open(row.ref)}>
            <span className="ph-grow"><strong>{row.name}</strong><small>{row.hostName} · {row.offline ? "Offline" : needed ? `${needed} need${needed === 1 ? "s" : ""} you` : "Open conversation"}</small></span><ChevronRight size={15}/>
          </button>
          {home && <button type="button" className="ph-assistant-settings" aria-label={`${row.name} settings on ${row.hostName}`} disabled={row.offline} onClick={() => setTarget({ routeId: home.routeHostId, hostId: row.ref.hostId, assistant: row.ref })}><Settings size={17}/></button>}
        </div>;
      })}
      {collection.hosts.map(home => {
        const host = hosts.find(h => h.machine.id === home.routeHostId);
        const canCreate = !!home.hostId && (home.state === "ready" || home.state === "empty") && host?.supports("assistant_workspace_v4");
        return <button type="button" key={home.routeHostId} className="ph-srow" disabled={!canCreate} onClick={() => {
          if (home.hostId) setTarget({ routeId: home.routeHostId, hostId: home.hostId });
        }}><span className="ph-grow"><strong>Add assistant on {home.name}</strong>{home.problem && <small>{home.problem}</small>}</span><ChevronRight size={15}/></button>;
      })}
    </div>
    {collection.archivedAssistants.length > 0 && <details className="ph-list">
      <summary>Archived assistants</summary>
      {collection.archivedAssistants.map(row => <button key={assistantIdentityKey(row.ref)} type="button" className="ph-srow" disabled={row.offline} onClick={async () => {
        setRestoreError("");
        try { await collection.restoreAssistant(row.ref, row.revision); }
        catch (error) { setRestoreError(String(error)); }
      }}>Restore {row.name} on {row.hostName}</button>)}
      {restoreError && <p role="alert">{restoreError}</p>}
    </details>}
    {target && <AssistantCreationDialog title={target.assistant ? "Assistant settings" : "Add a teammate"} onClose={() => setTarget(null)}>
      {!backend || !available || (target.assistant && !editing) ? <p role="alert">Reconnect the assistant’s machine to continue.</p>
        : problem ? <p role="alert">{problem}</p>
        : snapshot?.backend !== backend ? <p role="status">Loading this machine…</p>
        : <AssistantEditor key={target.assistant ? assistantIdentityKey(target.assistant) : target.hostId}
            backend={backend} profiles={snapshot.profiles} hostId={target.hostId}
            projects={snapshot.projects} machineName={route.name} lane={editing ?? undefined}
            onCreate={async input => {
              const { request, brief } = splitFirstBrief(input);
              const ref = await collection.create(target.routeId, request, target.hostId);
              if (brief) prefillAssistantComposer(assistantIdentityKey(ref), brief);
              return ref;
            }}
            onArchived={() => setTarget(null)}
            onSaved={ref => { if (ref) open(ref); else setTarget(null); }} />}
    </AssistantCreationDialog>}
  </>;
}
