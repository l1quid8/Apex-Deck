import { useEffect, useRef, useState } from 'react';
import type { Backend } from './backend';
import type { Pane, RoomOptions, ThreadStatus, Workspace } from './types';
import { mountWorktree } from './worktreeMount';

interface Request { path: string; workspaceId: string; backend: Backend }
/** Requests stay bound to their original chat and machine, even when focus moves. */
export function useWorktreeMount({ panes, workspaces, status, options, setFolder, error }: {
  panes: Pane[]; workspaces: Workspace[]; status: Record<string, ThreadStatus>; options: RoomOptions;
  setFolder: (id: string, cwd: string) => void; error: (message: string) => void;
}) {
  const [pending, setPending] = useState<Record<string, Request>>({});
  const requests = useRef(pending); requests.current = pending;
  const latest = useRef({panes, workspaces, status, options, setFolder, error}); latest.current = {panes, workspaces, status, options, setFolder, error};
  const running = useRef(new Set<string>());
  useEffect(() => {
    if (!Object.keys(pending).length) return;
    let disposed = false;
    const drain = async () => {
      for (const [id, request] of Object.entries(requests.current)) {
        if (disposed || running.current.has(id) || requests.current[id] !== request) continue;
        const context = latest.current;
        const pane = context.panes.find(p => p.id === id) as (Pane & {assistantTaskId?: string; executionPath?: string}) | undefined;
        const state = context.status[id];
        const workspace = context.workspaces.find(w => w.id === pane?.workspaceId);
        if (!pane || pane.kind !== 'chat' || pane.closed || pane.archived || pane.assistantTaskId || pane.executionPath || pane.workspaceId !== request.workspaceId || !workspace || (workspace.hostId ?? "local") !== (request.backend.host?.id ?? "local")) { setPending(all => { const next={...all}; if(next[id]===request) delete next[id]; return next; }); continue; }
        if (!state || state.busy || state.replying.length || state.waiting.length) continue;
        running.current.add(id);
        try {
          await mountWorktree(request.backend, id, request.path, context.options, cwd => {
            const current = latest.current;
            const pane = current.panes.find(p => p.id === id);
            const workspace = current.workspaces.find(w => w.id === pane?.workspaceId);
            if (pane?.workspaceId === request.workspaceId && workspace && (workspace.hostId ?? 'local') === (request.backend.host?.id ?? 'local')) current.setFolder(id, cwd);
          });
          setPending(all => { const next={...all}; if(next[id]===request) delete next[id]; return next; });
        } catch (reason) {
          if (!String(reason).includes('room-busy:')) {
            setPending(all => { const next={...all}; if(next[id]===request) delete next[id]; return next; });
            context.error(/unknown variant.*room_mount|unsupported.*room_mount|unknown command.*room_mount/i.test(String(reason))
              ? 'Update this machine’s Deck service to mount worktrees.' : `Could not mount worktree: ${String(reason)}`);
          }
        } finally { running.current.delete(id); }
      }
    };
    void drain();
    const timer = window.setInterval(() => void drain(), 750);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [pending, status]);
  return {
    pending,
    request(pane: Pane, path: string, backend: Backend) { if (!running.current.has(pane.id)) setPending(all => ({...all, [pane.id]: {path, workspaceId:pane.workspaceId, backend}})); },
    cancel(id: string) { if (!running.current.has(id)) setPending(all => { const next={...all}; delete next[id]; return next; }); },
  };
}
