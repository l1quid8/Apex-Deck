import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Backend } from './backend';
import { Diff } from './ApprovalCard';
import { gitGates, reconcileSelection, selectTurnFiles, type GitAction, type GitOutcome, type GitState } from './gitChanges';
import './gitChanges.css';

export interface GitMenuRequest { paths: string[] | null; nonce: number; note?: string }
interface Props {
  onWorktrees?: () => void;
  backend: Backend; room: string; cwd: string; active: boolean; ready: boolean; revision: number;
  request: GitMenuRequest | null; target: HTMLElement | null; canOpen: boolean; onOpen: () => void; onClose: () => void; onReview: () => void; onChanged: () => void;
}

/** One live checkout card, mounted inside the selected reply. */
export function GitChangesMenu({ backend, room, cwd, active, ready, revision, request, target, canOpen, onOpen, onClose, onReview, onChanged, onWorktrees }: Props) {
  const id = useId();
  const open = request !== null;
  const [state, setState] = useState<GitState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const selection = useRef<string[] | null>(null);
  const turnScope = useRef<string[] | null | undefined>(undefined);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<GitAction['kind'] | null>(null);
  const working = useRef(false);
  const [confirm, setConfirm] = useState<'pr' | 'merge' | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeCard = useCallback(() => { onClose(); setConfirm(null); opener.current?.focus(); }, [onClose]);
  const serial = useRef(0);
  const reading = useRef(false);
  const observed = useRef<GitState | null>(null);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const ticket = ++serial.current;
    setLoading(true);
    try {
      const next = await backend.call<GitState>('room_git_status', { id: room });
      if (ticket !== serial.current) return;
      const before = observed.current;
      if (before && (before.head !== next.head || before.tree !== next.tree || before.targetHead !== next.targetHead || before.branch !== next.branch || before.clean !== next.clean)) setConfirm(null);
      observed.current = next;
      const scope = turnScope.current;
      const picked = scope ? selectTurnFiles(next.files, scope, next.root, cwd)
        : selection.current === null ? next.files.filter(f => !f.stagedOnly).map(f => f.path)
        : reconcileSelection(next.files, selection.current);
      if (scope) setStatus(request?.note ?? (picked.length ? 'This turn’s current files are selected.' : 'No current changes match this turn.'));
      turnScope.current = undefined;
      selection.current = picked;
      setSelected(picked); setState(next); setError('');
    } catch (e) {
      if (ticket === serial.current) {
        setState(null); setConfirm(null);
        const text = String(e);
        setError(/unknown variant|unknown command/i.test(text) ? 'Update this machine’s Deck service to use Git actions.' : text);
      }
    } finally { reading.current = false; if (ticket === serial.current) setLoading(false); }
  }, [backend, room, cwd, request?.note]);
  useEffect(() => {
    if (!ready || (!active && !open) || working.current) return;
    void refresh();
    const timer = window.setInterval(() => { if (!working.current) void refresh(); }, open ? 5000 : 30000);
    return () => { window.clearInterval(timer); };
  }, [refresh, ready, active, open, revision, busy]);
  useEffect(() => () => { ++serial.current; }, []);
  useEffect(() => {
    if (!request) return;
    turnScope.current = request.paths;
    if (request.paths === null) selection.current = null;
    setConfirm(null); setExpanded(null);
    if (ready && !working.current) void refresh();
  }, [request, refresh, ready]);
  useEffect(() => { if (!active && open) onClose(); }, [active, open, onClose]);
  useLayoutEffect(() => {
    if (!open || !target) return;
    if (document.activeElement instanceof HTMLElement && !menu.current?.contains(document.activeElement)) opener.current = document.activeElement;
    menu.current?.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && menu.current?.contains(document.activeElement)) {
        e.preventDefault(); e.stopPropagation(); closeCard();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, target, request?.nonce, closeCard]);
  const choose = (path: string, checked: boolean) => {
    const next = checked ? [...selected, path] : selected.filter(p => p !== path);
    selection.current = next; setSelected(next); setConfirm(null);
  };
  const perform = async (kind: GitAction['kind']) => {
    if (!state || !ready || working.current || loading) return;
    if (kind === 'commit' && (!message.trim() || !selected.length)) return;
    working.current = true; ++serial.current; setBusy(kind); setError(''); setConfirm(null);
    setStatus(kind === 'checks' ? 'Running TypeScript checks…' : kind === 'pr' ? 'Publishing branch and opening PR…' : kind === 'merge' ? 'Merging branch…' : 'Committing selected files…');
    try {
      const expected = { ...state, files: [] };
      const action: GitAction = kind === 'commit' ? { kind, expected, paths: selected, message: message.trim() } : { kind, expected };
      const result = await backend.call<GitOutcome>('room_git_action', { id: room, action });
      observed.current = result.state; setState(result.state); setStatus(result.message);
      if (kind === 'commit') setMessage('');
      const next = reconcileSelection(result.state.files, selection.current ?? []);
      selection.current = next; setSelected(next); onChanged();
    } catch (e) { setError(String(e)); setStatus(''); }
    finally { working.current = false; setBusy(null); void refresh(); }
  };
  const gates = state ? gitGates(state) : { checks: false, pr: false, merge: false };
  const blocked = Boolean(!ready || busy || loading);
  const committed = Boolean(state?.clean && state.ahead > 0);
  const steps = [committed, Boolean(state?.checksPassed), false];
  const currentStep = steps.findIndex(done => !done);
  const mergeReason = !state ? 'Read repository state first.' : !state.branch ? 'Check out a branch.' : !state.target ? 'No local target branch.' : state.branch === state.target ? 'Already on the target branch.' : !state.clean ? 'Commit or resolve working changes first.' : !state.ahead ? 'No commits to merge.' : state.behind ? 'Update from the target, then rerun checks.' : !state.checksPassed ? 'Run checks on the latest commit.' : `Merge into ${state.target} and delete ${state.branch}`;
  return <>
    <button ref={button} type="button" className={`ghost small git-changes-trigger${state?.clean ? ' is-clean' : ''}`} aria-label={`Changes${state ? ` · ${state.files.length}` : ''}`} aria-expanded={open} aria-controls={id} disabled={!ready || (!open && !canOpen)} title="Working tree changes" onClick={() => { button.current?.focus(); setConfirm(null); onOpen(); }}>
      <span className="git-state-dot" aria-hidden="true" /><span>{state ? state.files.length : '±'}</span><span className="count-label"> {state?.files.length === 1 ? 'change' : 'changes'}</span>
    </button>
    {open && target && createPortal(<div id={id} ref={menu} tabIndex={-1} className="git-changes-menu" role="region" aria-label="Working tree changes" aria-busy={Boolean(busy)}>
      <header className="git-menu-head"><span className="git-state-dot" aria-hidden="true" /><strong>{state ? `${state.files.length} changes` : 'Changes'}</strong><span className="git-card-branch">{onWorktrees ? <button type="button" className="ghost" title="Show worktrees" onClick={onWorktrees}><code>{state?.branch ?? (state ? 'Detached HEAD' : '')}</code></button> : <code>{state?.branch ?? (state ? 'Detached HEAD' : '')}</code>}{state?.target ? ` → ${state.target}` : ''}</span><span className="git-live-label">live now</span><button type="button" className="git-icon" aria-label="Refresh changes" disabled={blocked} onClick={() => void refresh()}>↻</button><button type="button" className="git-icon" aria-label="Close changes" onClick={closeCard}>×</button></header>
      {state && <>
        <div className="git-file-list" aria-label="Current changed files">
          {state.files.length === 0 && <p className="git-empty">{state.clean ? 'Nothing to commit' : 'Resolve staged changes in Git first.'}</p>}
          {state.files.map(file => <div key={file.path} className="git-file-entry">
            <div className="git-file-row">
              <input id={`${id}-${file.path}`} type="checkbox" aria-label={`Include ${file.path} in commit`} checked={selected.includes(file.path)} disabled={blocked || file.stagedOnly} onChange={e => choose(file.path, e.target.checked)} />
              <button type="button" className="git-file-name" title={file.stagedOnly ? `${file.path} · staged changes differ from working copy; resolve staging in Git first` : file.path} aria-expanded={expanded === file.path} onClick={() => setExpanded(v => v === file.path ? null : file.path)}>{file.path}</button>
              {request?.paths && selectTurnFiles([file], request.paths, state.root, cwd).length > 0 && <span className="git-turn-mark" title="Changed in this turn" aria-label="Changed in this turn" />}
              <span className="git-file-stat" title={file.stagedOnly ? 'Staged only' : undefined}><span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span>{file.stagedOnly ? ' *' : ''}</span>
            </div>
            {expanded === file.path && <div className="git-file-patch"><Diff text={file.patch} /></div>}
          </div>)}
        </div>
        {state.files.some(f => !f.stagedOnly) && <form className="git-commit-row" onSubmit={e => { e.preventDefault(); void perform('commit'); }}>
          <label className="git-sr-only" htmlFor={`${id}-message`}>Commit message</label><input id={`${id}-message`} aria-label="Commit message" placeholder="Commit message" maxLength={500} value={message} disabled={Boolean(busy)} onChange={e => setMessage(e.target.value)} />
          <button type="submit" className="git-primary" disabled={blocked || !selected.length || !message.trim() || !state.branch} title="Commit the full current contents of selected files">{busy === 'commit' ? 'Committing…' : selected.length === state.files.length ? 'Commit' : `Commit ${selected.length} of ${state.files.length}`}</button>
        </form>}
        <ol className="git-step-rail" aria-label="Steps to merge">{['Commit', 'Checks', 'Merge'].map((label, i) => <li key={label} className={steps[i] ? 'done' : currentStep === i ? 'current' : ''} aria-current={currentStep === i ? 'step' : undefined}><span className="git-step-dot" aria-hidden="true">{steps[i] ? '✓' : ''}</span>{i === 1 && committed && !state.checksPassed ? <button type="button" disabled={blocked || !gates.checks} title="Run npx --no-install tsc --noEmit" onClick={() => void perform('checks')}>{busy === 'checks' ? 'Checking…' : 'Run checks'}</button> : label}</li>)}</ol>
        <div className="git-branch-actions"><button type="button" disabled={blocked || !gates.pr} title="Publish this branch to origin and create or find its GitHub PR" onClick={() => setConfirm('pr')}>Open PR</button><button type="button" className={gates.merge ? 'git-primary' : ''} disabled={blocked || !gates.merge} title={mergeReason} onClick={() => setConfirm('merge')}>Merge</button></div>
        {confirm && <div className="git-confirm"><p>{confirm === 'merge' ? `Merge ${state.ahead} commit${state.ahead === 1 ? '' : 's'} into ${state.target} and delete ${state.branch}?` : `Publish ${state.ahead} commit${state.ahead === 1 ? '' : 's'} to origin and open a PR into ${state.target}? Uncommitted files are excluded.`}</p><button type="button" className="git-primary" disabled={blocked} onClick={() => void perform(confirm)}>{confirm === 'merge' ? 'Confirm merge' : 'Publish & open PR'}</button><button type="button" disabled={blocked} onClick={() => setConfirm(null)}>Cancel</button></div>}
      </>}
      {loading && !state && <p className="git-empty" role="status">Reading Git state…</p>}
      <div className="git-menu-foot"><span>{state ? `${state.ahead} ahead${state.behind ? ` · ${state.behind} behind` : ''}` : ''}</span><button type="button" onClick={() => { onClose(); onReview(); }}>Thread diff</button></div>
      {error && <p className="git-menu-error" role="alert">{error}</p>}
      {status && <p className="git-menu-status" role="status">{status}</p>}
    </div>, target)}
  </>;
}
