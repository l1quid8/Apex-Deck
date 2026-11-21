import type { GitState } from './gitChanges';

export type ThreadGitAction = 'push' | 'request_merge' | 'cancel_merge' | 'ask_fix';

export function ThreadGitActions({ state, blocked, perform, status, error }: {
  state: GitState | null; blocked: boolean; perform(kind: ThreadGitAction): Promise<void>;
  status: string; error: string;
}) {
  const flow = state?.workflow;
  const reviewed = Boolean(flow?.reviewer && flow.head === state?.head);
  const pending = Boolean(flow && ['preparing', 'checks', 'submitting', 'cancelling','syncing'].includes(flow.phase));
  const current = flow?.head === state?.head ? flow : undefined;
  const actionable = state?.branch && state.branch !== 'main' && state.branch !== 'master' && (state.ahead > 0 || pending || current);
  return actionable && <div className="git-thread-actions" aria-label="Thread Git actions">
    {current?.phase !== 'merged' && current?.phase !== 'syncing' && <div className="git-branch-actions">
      <button type="button" title={`Push committed changes to ${state.originRepo ?? "origin"}/${state.branch}`} disabled={blocked || pending || current?.pushed || !state.originRepo} onClick={() => void perform('push')}>{current?.pushed ? 'Pushed' : 'Push'}</button>
      <button type="button" className="git-primary" disabled={blocked || !reviewed || !['ready','cancelled'].includes(current?.phase ?? '')} onClick={() => void perform('request_merge')}>
        {pending ? flow?.phase === 'cancelling' ? 'Confirming cancellation…' : flow?.phase === 'submitting' ? 'Confirming merge…' : 'Waiting for checks…' : !reviewed ? 'Waiting for review' : 'Merge to main'}
      </button>
      {pending && <button type="button" disabled={blocked || flow?.phase === 'cancelling'} onClick={() => void perform('cancel_merge')}>Cancel</button>}
      {current?.phase === 'failed' && <button type="button" disabled={blocked || current.fix_requested} onClick={() => void perform('ask_fix')}>{current.fix_requested ? 'Fix requested' : 'Ask agent to fix · uses one model turn'}</button>}
    </div>}
    <p className="git-menu-status" role="status">{(pending ? flow : current)?.detail.split('\n')[0] ?? state.workflowError ?? 'Waiting for a different model to review this commit.'}</p>
    {current?.phase === 'failed' && <details><summary>Show check output</summary><pre>{current.detail}</pre></details>}
    {status && !pending && (!flow || current?.phase === 'ready') && status !== flow?.detail && <p role="status">{status}</p>}
    {error && <p className="git-menu-error" role="alert">{error}</p>}
  </div>;
}
