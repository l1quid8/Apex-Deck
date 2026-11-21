import { normalizeDiffPath } from './diffPaths.ts';
export interface GitFile { path: string; added: number; removed: number; patch: string; stagedOnly: boolean }
export interface ThreadWorkflow {
  head: string; branch: string; root: string; repo: string; builder: string; builder_model: string;
  reviewer: string | null; result_oid?: string | null; phase: 'syncing' | 'ready' | 'preparing' | 'checks' | 'submitting' | 'cancelling' | 'cancelled' | 'failed' | 'blocked' | 'merged';
  generation: number; pr: number | null; detail: string; pushed: boolean; fix_requested: boolean;
}
export interface GitState {
  workflowError?: string | null; originRepo?: string | null; workflow?: ThreadWorkflow;
  root: string; head: string; tree: string; branch: string | null; target: string | null; targetHead: string | null;
  ahead: number; behind: number; files: GitFile[]; checksPassed: boolean; clean: boolean;
}
export type GitAction =
  | { kind: 'commit'; expected: GitState; paths: string[]; message: string }
  | { kind: 'checks' | 'pr' | 'merge'; expected: GitState };
export interface GitOutcome { state: GitState; message: string }

type SelectableFile = { path: string; stagedOnly?: boolean };
export function selectTurnFiles(files: SelectableFile[], paths: string[], root: string, cwd: string): string[] {
  const wanted = new Set(paths.map(path => normalizeDiffPath(root, path.startsWith('/') ? path : `${cwd}/${path}`)));
  return files.filter(file => !file.stagedOnly && wanted.has(file.path)).map(file => file.path);
}
export function reconcileSelection(files: SelectableFile[], selected: string[]): string[] {
  const wanted = new Set(selected);
  return files.filter(file => !file.stagedOnly && wanted.has(file.path)).map(file => file.path);
}
export function gitGates(state: Pick<GitState, 'branch' | 'target' | 'ahead' | 'behind' | 'clean' | 'checksPassed'>) {
  const branch = Boolean(state.branch && state.target && state.branch !== state.target && state.ahead > 0);
  return {
    pr: branch,
    // Checks read an isolated checkout of the commit, so unrelated uncommitted
    // work neither blocks them nor vouches for code that was never tested.
    checks: branch && !state.checksPassed,
    merge: branch && state.checksPassed && state.behind === 0,
  };
}
