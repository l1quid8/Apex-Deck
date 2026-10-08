import type { Backend } from '../backend';
import type { Pane } from '../types';

/** Keep each load/change/save together, including after a failed edit. */
export function serialEdits() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(edit: () => Promise<T>): Promise<T> => {
    const result = tail.then(edit);
    tail = result.catch(() => {});
    return result;
  };
}

/** Stop work before removing saved rows; keep room history available to Undo. */
export async function stopProjectPanes(panes: readonly Pane[], backend: Pick<Backend, 'roomClose' | 'ptyKill'>, clearQueue: (id: string) => void) {
  for (const pane of panes) clearQueue(pane.id);
  for (const pane of panes) {
    if (pane.kind === 'chat') await backend.roomClose(pane.id);
    else if (pane.kind === 'terminal') await backend.ptyKill(pane.id);
  }
}
