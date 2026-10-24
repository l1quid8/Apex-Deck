// What an assistant actually made: the files inside the review patches its
// tasks recorded. No new host command — this reads `resultData.reviewDiff`,
// which the host already writes when a task stops for review, and turns it
// into the same per-file shape Changes uses (path, +, −, patch, kind).
//
// The parse mirrors the host's `changes::split_patch`: a file starts at a
// "diff --git " line, and takes its name from "+++ b/…", falling back to the
// header so a deleted file keeps the path it had.

export type OutputKind = 'created' | 'changed' | 'deleted';

export interface OutputFile {
  /** Path as the patch names it, relative to the task's folder. */
  path: string;
  added: number;
  removed: number;
  patch: string;
  kind: OutputKind;
}

/** One file for the person to look at, merged across every task that touched it. */
export interface AssistantOutput extends OutputFile {
  /** The tasks that recorded this file, oldest first. */
  taskIds: string[];
}

export interface RecordedTask {
  id: string;
  resultData?: { reviewDiff?: string } | null;
}

const HEADER = 'diff --git ';

/** Split one recorded patch into its files, in the order the patch lists them. */
export function parsePatchFiles(patch: string): OutputFile[] {
  const files: OutputFile[] = [];
  let current: OutputFile | null = null;
  const lines = patch.split('\n');
  // A patch that ends in a newline gets one empty trailing segment; keeping it
  // would add a newline the patch never had.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith(HEADER)) {
      const header = line.slice(HEADER.length);
      const split = header.indexOf(' b/');
      current = { path: split < 0 ? header : header.slice(split + 3), added: 0, removed: 0, patch: '', kind: 'changed' };
      files.push(current);
    }
    if (!current) continue;
    current.patch += `${line}\n`;
    if (line.startsWith('new file mode')) { current.kind = 'created'; continue; }
    if (line.startsWith('deleted file mode')) { current.kind = 'deleted'; continue; }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).split('\t')[0];
      // "+++ /dev/null" is a deletion; its name stays what the header gave.
      if (target === '/dev/null') current.kind = 'deleted';
      else if (target.startsWith('b/')) current.path = target.slice(2);
      continue;
    }
    // A file header line, not a content line.
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
  }
  return files;
}

/** Every file these tasks recorded making or changing, one row per path. */
export function assistantOutputs(tasks: RecordedTask[]): AssistantOutput[] {
  const byPath = new Map<string, AssistantOutput>();
  for (const task of tasks) {
    const patch = task.resultData?.reviewDiff;
    if (typeof patch !== 'string' || patch.trim() === '') continue;
    for (const file of parsePatchFiles(patch)) {
      if (!file.path) continue;
      const seen = byPath.get(file.path);
      if (!seen) { byPath.set(file.path, { ...file, taskIds: [task.id] }); continue; }
      seen.added += file.added;
      seen.removed += file.removed;
      if (file.patch.length > seen.patch.length) seen.patch = file.patch;
      if (!seen.taskIds.includes(task.id)) seen.taskIds.push(task.id);
      // A file the assistant created stays created even if a later task edited it.
      if (file.kind === 'created') seen.kind = 'created';
      else if (file.kind === 'deleted' && seen.kind === 'changed') seen.kind = 'deleted';
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** "src/App.tsx" → { name: "App.tsx", folder: "src" }. */
export function outputName(path: string): { name: string; folder: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { name: path, folder: '' } : { name: path.slice(cut + 1), folder: path.slice(0, cut) };
}

/** "3 files · +48 −6", the same wording Changes uses. */
export function outputsLine(files: { added: number; removed: number }[]): string {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return `${files.length === 1 ? '1 file' : `${files.length} files`} · +${added} −${removed}`;
}

/** The short mark Codex and git both use for a row. */
export function outputMark(kind: OutputKind): string {
  return kind === 'created' ? 'A' : kind === 'deleted' ? 'D' : 'M';
}

/** Plain-language row text for the file list. */
export function outputKindLabel(kind: OutputKind): string {
  return kind === 'created' ? 'Created' : kind === 'deleted' ? 'Deleted' : 'Changed';
}
