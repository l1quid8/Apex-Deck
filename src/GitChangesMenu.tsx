import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Backend } from './backend';
import { Diff } from './ApprovalCard';
import { selectTurnFiles, type GitOutcome, type GitState } from './gitChanges';
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
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const working = useRef(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeCard = useCallback(() => { onClose(); opener.current?.focus(); }, [onClose]);
  const serial = useRef(0);
  const reading = useRef(false);
  const [showUnselected, setShowUnselected] = useState(false);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const ticket = ++serial.current;
    setLoading(true);
    try {
      const next = await backend.call<GitState>('room_git_status', { id: room });
      if (ticket !== serial.current) return;
      setState(next); setError('');
    } catch (e) {
      if (ticket === serial.current) {
        setState(null);
        const text = String(e);
        setError(/unknown variant|unknown command/i.test(text) ? 'Update this machine’s Deck service to use Git actions.' : text);
      }
    } finally { reading.current = false; if (ticket === serial.current) setLoading(false); }
  }, [backend, room, cwd, request?.note]);
  useEffect(() => {
    if (!ready || (!active && !open) || working.current) return;
    void refresh();
    const timer = window.setInterval(() => { if (!working.current) void refresh(); }, open || state?.workflow ? 5000 : 30000);
    return () => { window.clearInterval(timer); };
  }, [refresh, ready, active, open, revision, busy, Boolean(state?.workflow)]);
  useEffect(() => () => { ++serial.current; }, []);
  useEffect(() => {
    if (!request) return;
    setShowUnselected(false);
    setExpanded(null);
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
  const push = async () => {
    if (!ready || !state || working.current) return;
    working.current = true;
    ++serial.current;
    setBusy("push"); setError(''); setStatus('');
    try {
      const action = {kind: "push" as const, expected: {...state, files: []}};
      const result = await backend.call<GitOutcome>('room_thread_git_action', {id: room, action});
      setState(result.state); setStatus(result.message); onChanged();
    } catch (e) { setError(String(e)); }
    finally { working.current = false; setLoading(false); setBusy(null); }
  };
  const blocked = !ready || Boolean(busy);
  const workflow = state?.workflow;
  const current = workflow && workflow.head === state?.head ? workflow : undefined;
  const pending = workflow && ["preparing", "checks", "submitting", "cancelling", "syncing"].includes(workflow.phase);
  return <>
    <button ref={button} type="button" className={`ghost small git-changes-trigger${state?.clean ? ' is-clean' : ''}`} aria-label={`Changes${state ? ` · ${state.files.length}` : ''}`} aria-expanded={open} aria-controls={id} disabled={!ready || (!open && !canOpen)} title="Working tree changes" onClick={() => { button.current?.focus(); onOpen(); }}>
      <span className="git-state-dot" aria-hidden="true" /><span>{state ? state.files.length : '±'}</span><span className="count-label"> {state?.files.length === 1 ? 'change' : 'changes'}</span>
    </button>
    {open && target && createPortal(<div id={id} ref={menu} tabIndex={-1} className="git-changes-menu" role="region" aria-label="Working tree changes" aria-busy={Boolean(busy)}>
      <header className="git-menu-head"><span className="git-state-dot" aria-hidden="true" /><strong>{state ? `${state.files.length} changes` : 'Changes'}</strong><span className="git-card-branch">{onWorktrees ? <button type="button" className="ghost" title="Show worktrees" onClick={onWorktrees}><code>{state?.branch ?? (state ? 'Detached HEAD' : '')}</code></button> : <code>{state?.branch ?? (state ? 'Detached HEAD' : '')}</code>}{state?.target ? ` → ${state.target}` : ''}</span><span className="git-live-label">live now</span><button type="button" className="git-icon" aria-label="Refresh changes" disabled={blocked || loading} onClick={() => void refresh()}>↻</button><button type="button" className="git-icon" aria-label="Close changes" onClick={closeCard}>×</button></header>
      {state && (() => {
        const scoped = request?.paths ? new Set(selectTurnFiles(state.files, request.paths, state.root, cwd)) : null;
        const selectedFiles = state.files.filter(f => !scoped || scoped.has(f.path));
        const unselectedFiles = state.files.filter(f => scoped && !scoped.has(f.path));
        return <>
        <div className="git-file-list" aria-label="Current changed files">
          {state.files.length === 0 && <p className="git-empty">{state.clean ? 'No uncommitted changes' : 'Resolve staged changes in Git first.'}</p>}
          {selectedFiles.map(file => <div key={file.path} className="git-file-entry">
            <div className="git-file-row">
              <button type="button" className="git-file-name" title={file.stagedOnly ? `${file.path} · staged changes differ from working copy; resolve staging in Git first` : file.path} aria-expanded={expanded === file.path} onClick={() => setExpanded(v => v === file.path ? null : file.path)}>{file.path}</button>
              {request?.paths && selectTurnFiles([file], request.paths, state.root, cwd).length > 0 && <span className="git-turn-mark" title="Changed in this turn" aria-label="Changed in this turn" />}
              <span className="git-file-stat" title={file.stagedOnly ? 'Staged only' : undefined}><span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span>{file.stagedOnly ? ' *' : ''}</span>
            </div>
            {expanded === file.path && <div className="git-file-patch"><Diff text={file.patch} /></div>}
          </div>)}
          {unselectedFiles.length > 0 && <div className="git-unselected-group">
            <button type="button" className="git-unselected-toggle" aria-expanded={showUnselected} aria-label={`${showUnselected ? 'Hide' : 'Show'} ${unselectedFiles.length} unselected file${unselectedFiles.length === 1 ? '' : 's'}`} onClick={() => setShowUnselected(v => !v)}>{showUnselected ? '▼' : '▶'} {unselectedFiles.length} unselected file{unselectedFiles.length === 1 ? '' : 's'}</button>
            {showUnselected && unselectedFiles.map(file => <div key={file.path} className="git-file-entry is-unselected">
              <div className="git-file-row">
                <button type="button" className="git-file-name" title={file.stagedOnly ? `${file.path} · staged changes differ from working copy; resolve staging in Git first` : file.path} aria-expanded={expanded === file.path} onClick={() => setExpanded(v => v === file.path ? null : file.path)}>{file.path}</button>
                <span className="git-file-stat" title={file.stagedOnly ? 'Staged only' : undefined}><span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span>{file.stagedOnly ? ' *' : ''}</span>
              </div>
              {expanded === file.path && <div className="git-file-patch"><Diff text={file.patch} /></div>}
            </div>)}
          </div>}
        </div>
        {state.branch && !["main", "master"].includes(state.branch) && (state.ahead > 0 || current) && current?.phase !== "merged" &&
          <div className="git-branch-actions"><button type="button" title={`Push committed changes to origin/${state.branch}`}
            disabled={blocked || pending || current?.pushed || !state.originRepo} onClick={() => void push()}>{current?.pushed ? "Pushed" : "Push"}</button></div>}
        {status && <p role="status">{status}</p>}
      </>; })()}
      {loading && !state && <p className="git-empty" role="status">Reading Git state…</p>}
      <div className="git-menu-foot"><span>{state ? `${state.ahead} ahead${state.behind ? ` · ${state.behind} behind` : ''}` : ''}</span><button type="button" onClick={() => { onClose(); onReview(); }}>Thread diff</button></div>
      {error && <p className="git-menu-error" role="alert">{error}</p>}

    </div>, target)}
  </>;
}
