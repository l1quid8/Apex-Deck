// Reviewing a delegated result inside the Details tab (§5.4). It uses the same
// `assistant_task_action` calls and the same revision check the full page does:
// the revision on screen is the revision that gets accepted, and the host
// refuses a stale one. Nothing here opens a page or closes the sidebar.

import { useState } from 'react';
import type { Backend } from './backend';
import { assistantTaskActionArgs, taskStatusLabel, type AssistantTask } from './assistantTaskModel';
import './assistant-review.css';

/** One row of "Files changed", read back from the patch the host recorded. */
export interface ReviewFile { path: string; added: number; removed: number }
export interface ReviewCheck { command: string; passed: boolean; detail?: string }

/** Files and line counts from a unified diff. Header lines never count as changes. */
export function reviewFiles(diff: string | undefined): ReviewFile[] {
  if (!diff || !diff.trim()) return [];
  const blocks = diff.split(/\n(?=diff --git )/);
  const files: ReviewFile[] = [];
  for (const block of blocks) {
    const head = block.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const path = head ? head[2] : block.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    if (!path) continue;
    let added = 0;
    let removed = 0;
    for (const line of block.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
    files.push({ path, added, removed });
  }
  return files;
}

/** Recorded checks, as the host stores them: `{argv, success, error?}` per entry. */
export function reviewChecks(entries: unknown): ReviewCheck[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as { argv?: unknown; success?: unknown; error?: unknown };
    const command = Array.isArray(row.argv) ? row.argv.filter((part): part is string => typeof part === 'string').join(' ').trim() : '';
    if (!command) return [];
    const detail = typeof row.error === 'string' && row.error.trim() ? row.error.trim() : undefined;
    return [{ command, passed: row.success === true, ...(detail ? { detail } : {}) }];
  });
}

const MODE_WORDS: Record<string, string> = { read_only: 'read only', isolated: 'separate copy', project: 'your project folder' };

export function AssistantReview({ task, name, backend, onBack, onDone }: {
  task: AssistantTask;
  name: string;
  backend: Backend;
  onBack: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const files = reviewFiles(task.resultData?.reviewDiff);
  const checks = reviewChecks(task.resultData?.checkResults ?? task.resultData?.checks);
  const ready = task.status === 'ready_for_review';
  const writes = task.mode !== 'read_only';
  const summary = (task.result ?? '').trim();

  async function send(action: 'accept' | 'review' | 'request_changes') {
    if (busy || !ready) return;
    if (action === 'request_changes' && !note.trim()) return;
    setBusy(true);
    setProblem('');
    try {
      const result = await backend.call<AssistantTask>('assistant_task_action', assistantTaskActionArgs(task, action, action === 'request_changes' ? { text: note.trim() } : {}));
      if (result.id !== task.id) throw new Error('The host returned a different task.');
      onDone();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function accept() {
    // Applying a revision writes to a project folder, so it keeps the same confirmation the full page asks for.
    if (writes && typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm(`Accept changes from revision ${task.revision}? This applies only the reviewed task revision to ${task.owner.cwd}.`)) return;
    void send(writes ? 'accept' : 'review');
  }

  return (
    <section className="assistant-review" aria-label={`Review ${task.brief}`}>
      <button type="button" className="assistant-details-back" onClick={onBack}>{`‹ ${name}`}</button>
      <h3 className="assistant-review-title">{task.brief}</h3>
      <p className="assistant-review-meta">{`${name} · revision ${task.revision} · ${MODE_WORDS[task.mode] ?? task.mode}${writes ? '' : ' · nothing to apply'}`}</p>
      {summary ? <p className="assistant-review-summary">{summary.length > 700 ? `${summary.slice(0, 700)}…` : summary}</p> : <p className="assistant-details-note">The worker did not leave a written summary.</p>}

      <div className="assistant-review-block">
        <h4 className="assistant-review-block-title">Files changed</h4>
        {files.length > 0 ? (
          <ul className="assistant-review-files">
            {files.map((file) => (
              <li className="assistant-review-file" key={file.path}>
                <span className="assistant-review-path" title={file.path}>{file.path}</span>
                <span className="assistant-review-counts"><b>{`+${file.added}`}</b>{` −${file.removed}`}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="assistant-details-note">{task.mode === 'read_only' ? 'Read-only task. No files were written.' : 'The worker did not report a diff. Check the result before accepting.'}</p>
        )}
      </div>

      <div className="assistant-review-block">
        <h4 className="assistant-review-block-title">Checks</h4>
        {checks.length > 0 ? (
          <ul className="assistant-review-checks">
            {checks.map((check, index) => (
              <li className="assistant-review-check" key={`${check.command}:${index}`} data-passed={check.passed ? 'true' : 'false'}>
                <span className="assistant-review-check-mark" aria-hidden="true">{check.passed ? '✓' : '✗'}</span>
                <span className="assistant-review-check-name" title={check.command}>{check.command}</span>
                {check.detail ? <small className="assistant-review-check-detail">{check.detail}</small> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="assistant-details-note">No checks were recorded for this revision.</p>
        )}
      </div>

      <label className="assistant-review-note">
        <span>Anything to change?</span>
        <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>

      {problem ? <p role="alert" className="assistant-review-problem">{problem}</p> : null}

      <div className="assistant-review-actions">
        <button type="button" className="primary assistant-review-accept" disabled={busy || !ready} onClick={accept}>
          {writes ? `Accept revision ${task.revision}` : `Mark revision ${task.revision} reviewed`}
        </button>
        <button type="button" className="assistant-review-ask" disabled={busy || !ready || !note.trim()} onClick={() => void send('request_changes')}>Ask for changes</button>
      </div>

      <p role="status" className="assistant-details-note">
        {busy ? 'Sending…' : ready ? `Accepts only revision ${task.revision}. The host rejects a stale revision.` : `This revision is ${taskStatusLabel(task.status).toLowerCase()}, so it cannot be accepted yet.`}
      </p>
    </section>
  );
}
