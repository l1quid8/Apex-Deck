import type { Backend } from './backend';
import type { Pane, RoomOptions, Workspace } from './types';

export interface MountBoundary { seq: number; from: string; to: string; note?: string; changeCount?: number }
/** Every view/tool follows the same chat folder. Task-owned panes cannot mount. */
export function chatFolder(pane: (Pick<Pane, 'mount'> & {executionPath?: string}) | null | undefined, workspace: Pick<Workspace, 'path'> | null | undefined): string {
  return pane?.executionPath ?? pane?.mount ?? workspace?.path ?? '';
}
export function changeFolder(mounts: MountBoundary[], seq: number, cwd: string): string {
  let folder = mounts[0]?.from ?? cwd;
  for (const mount of mounts) { if (seq < mount.seq) break; folder = mount.to; }
  return folder;
}
export async function mountWorktree(backend: Backend, id: string, cwd: string, options: RoomOptions, onMounted: (cwd: string) => void = () => {}): Promise<string> {
  const mounted = await backend.call<{cwd: string}>('room_mount', {id, cwd});
  // room_mount has already persisted the switch. Views must follow it even
  // if rebuilding providers fails; retaining the old root would be misleading.
  onMounted(mounted.cwd);
  try { await backend.roomCreate(id, [], options, mounted.cwd); }
  catch (reason) { throw new Error(`Folder switched to ${mounted.cwd}, but the chat could not reopen: ${String(reason)}`); }
  const state = await backend.roomState?.(id);
  if (state?.cwd && state.cwd !== mounted.cwd) {
    onMounted(state.cwd);
    throw new Error('The chat folder changed while mounting. Reopen the chat.');
  }
  return mounted.cwd;
}
