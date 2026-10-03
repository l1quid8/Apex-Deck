import type { DiffFile } from "./types";

/** Files under the agent that changed them. `by: null` holds files no model
 *  reported: the person, a shell command or another app changed them. */
export interface DiffGroup { by: string | null; files: DiffFile[] }

export function groupDiff(files: DiffFile[], order: string[]): DiffGroup[] {
  const ids = [...order, ...files.flatMap((f) => f.by).filter((id, i, all) => !order.includes(id) && all.indexOf(id) === i)];
  const groups: DiffGroup[] = ids.map((by) => ({ by, files: files.filter((f) => f.by.includes(by)) }));
  groups.push({ by: null, files: files.filter((f) => f.by.length === 0) });
  return groups.filter((g) => g.files.length > 0);
}
