/**
 * Task 7: Slim handoff pill, read-only popover, clarification UI
 * - One sentence + small pill + hover/focus Stop (quiet, same height)
 * - View-only 40-cell tape popover (Round1: Try again only, no branch)
 * - Ordered agent/team with lead badge, preview before Start
 * - No ghost horizon colored border, fixed 24px composer auxiliary space handled by parent
 */
import { forwardRef, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AssistantTask } from './assistantTaskModel';
import type { PersonalLane, PendingHandoff, HandoffOptions, HandoffSelection, HandoffQuestion, PendingControlConfirmation } from './personalAssistant';
import { deriveHandoffPill, deriveHandoffPopover, classifyPlainHandoffReply, preserveTypedAgentOrder, type TaskConversationProgress, type TaskConversationEvent } from './assistantHandoffModel';

export function HandoffPillView({
  task,
  progress,
  events = [],
  threadLabel,
  sentence,
  offline = false,
  onStop,
  onRetry,
  onOpen,
}: {
  task: AssistantTask;
  progress?: TaskConversationProgress;
  events?: TaskConversationEvent[];
  threadLabel?: string;
  sentence?: string;
  offline?: boolean;
  onStop?: (taskId: string, revision: number) => void;
  onRetry?: (taskId: string, revision: number) => void;
  onOpen?: (taskId: string) => void;
}) {
  const pill = deriveHandoffPill(task, progress, threadLabel, offline);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeDetails = () => { setOpen(false); triggerRef.current?.focus(); };

  // Close on outside / Esc
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node) && anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDetails(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const showStop = !!onStop && pill.availableActions.includes('stop');

  return (
    <span className="assistant-handoff-line">
      {(sentence ?? pill.sentence) && <span className="assistant-handoff-sentence">{sentence ?? pill.sentence}</span>}{' '}
      <span className="assistant-handoff-pill-wrap" ref={anchorRef}>
        <button
          type="button"
          ref={triggerRef}
          className="assistant-handoff-pill"
          aria-label={`Progress: ${pill.label}. Click to see details.`}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen(v => !v)}
        >
          {pill.label} <span aria-hidden>▾</span>
        </button>
        {showStop && (
          <button
            type="button"
            className="assistant-handoff-stop quiet"
            aria-label={pill.stopA11yLabel}
            onClick={() => onStop?.(pill.taskId, pill.revision)}
          >
            Stop
          </button>
        )}
      </span>
      {open && (
        <HandoffPopover
          ref={popRef}
          task={task}
          progress={progress}
          events={events}
          offline={offline}
          onClose={closeDetails}
          onRetry={onRetry ? () => { onRetry(pill.taskId, pill.revision); closeDetails(); } : undefined}
          onOpenTask={() => onOpen?.(pill.taskId)}
        />
      )}
    </span>
  );
}

type PopoverProps = {
  task: AssistantTask;
  progress?: TaskConversationProgress;
  events: TaskConversationEvent[];
  offline?: boolean;
  onClose: () => void;
  onRetry?: () => void;
  onOpenTask: () => void;
};

const HandoffPopoverImpl = forwardRef<HTMLDivElement, PopoverProps>(function HandoffPopoverImpl(
  { task, progress, events, offline = false, onClose, onRetry, onOpenTask },
  ref
) {
  const model = deriveHandoffPopover(task, progress, events);
  const pill = deriveHandoffPill(task, progress, undefined, offline);
  const [selectedIndex, setSelectedIndex] = useState(model.currentIndex);

  // Keep selected in bounds when task updates
  useEffect(() => { setSelectedIndex(model.currentIndex); }, [model.currentIndex, model.taskId]);

  const selectedStep = model.steps.find(s => s.index === selectedIndex);

  return (
    <div className="assistant-handoff-popover" role="dialog" aria-label={`Progress for ${task.brief.slice(0, 60)}`} ref={ref}>
      <div className="assistant-handoff-popover-head">
        <strong>{model.steps.length ? `${offline ? 'Last reported: ' : ''}${model.steps.filter(s => s.state === 'done').length} of ${model.steps.length} done` : pill.label}</strong>
        <button type="button" className="assistant-handoff-close" aria-label="Close details" onClick={onClose}>✕</button>
      </div>

      {model.steps.length > 0 && (
        <div className="assistant-handoff-tape" role="group" aria-label="Execution steps">
          {model.steps.map(step => (
            <button
              key={step.index}
              type="button"
              className={`assistant-handoff-cell ${step.state}${selectedIndex === step.index ? ' is-selected' : ''}`}
              aria-label={`Step ${step.index}${step.state === 'done' ? ' done' : step.state === 'active' ? ' active' : step.state === 'cancelled' ? ' cancelled' : ''}`}
              onClick={() => setSelectedIndex(step.index)}
            />
          ))}
        </div>
      )}

      {selectedStep && (
        <div className="assistant-handoff-step-detail">
          <div className="assistant-handoff-step-title">Step {selectedStep.index}{selectedStep.state === 'done' ? ' · done' : selectedStep.state === 'active' ? ' · running' : selectedStep.state === 'cancelled' ? ' · cancelled' : ' · queued'}</div>
          {selectedStep.text && <div className="assistant-handoff-step-text">{selectedStep.text}</div>}
          {!selectedStep.text && <div className="assistant-handoff-step-text">No output recorded for this step.</div>}
        </div>
      )}

      <div className="assistant-handoff-actions">
        {model.canRetry && !offline && onRetry && <button type="button" className="primary" onClick={onRetry}>Try again</button>}
        <button type="button" onClick={onOpenTask}>Open task</button>
        <button type="button" onClick={onClose}>Close</button>
      </div>

      <div className="assistant-handoff-footer">View-only. Selecting a past step does not change execution.</div>
    </div>
  );
});

const HandoffPopover = HandoffPopoverImpl;

// ---------------------------------------------------------------------------
// Clarification UI: project/thread/agents with ordered multi-select and lead
// ---------------------------------------------------------------------------
export function AgentClarification({
  allAgents,
  agentNames = {},
  typedOrder,
  onOrderChange,
  onStart,
  onBack,
  questionId,
  isFirstQuestion,
}: {
  allAgents: string[];
  agentNames?: Record<string, string>;
  typedOrder: string[]; // ordered distinct
  onOrderChange: (ordered: string[]) => void;
  onStart: (ordered: string[]) => void;
  onBack?: () => void;
  questionId?: string;
  isFirstQuestion?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const [highlight, setHighlight] = useState(0);

  const filtered = allAgents.filter(a => (agentNames[a] ?? a).toLowerCase().includes(filter.toLowerCase()));
  const preview = typedOrder.length ? `${typedOrder.map(id => agentNames[id] ?? id).join(' + ')} · ${agentNames[typedOrder[0]] ?? typedOrder[0]} leads` : '';

  const toggle = (id: string) => {
    const exists = typedOrder.includes(id);
    const next = exists ? typedOrder.filter(x => x !== id) : [...typedOrder, id];
    // enforce max 10, distinct
    const dedup = [...new Set(next)].slice(0, 10);
    onOrderChange(dedup);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, Math.max(filtered.length - 1, 0))); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (filtered[highlight]) toggle(filtered[highlight]);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (typedOrder.length) onStart(typedOrder);
    }
  };

  return (
    <div className="assistant-handoff-clarify" data-question-id={questionId}>
      <div className="assistant-handoff-clarify-head">Who should work on this? Choose one or more.</div>
      <input type="text" placeholder="Filter agents…" value={filter} onChange={e => { setFilter(e.target.value); setHighlight(0); }} onKeyDown={onKey} aria-label="Filter agents" />
      <ul className="assistant-handoff-agent-list" role="listbox">
        {filtered.map((agent, idx) => {
          const checked = typedOrder.includes(agent);
          const isLead = checked && typedOrder[0] === agent;
          return (
            <li key={agent} role="option" aria-selected={checked} className={highlight === idx ? 'is-highlighted' : ''}>
              <label>
                <input type="checkbox" checked={checked} onChange={() => toggle(agent)} />
                <span>{agentNames[agent] ?? agent}</span>
                {isLead && <em className="assistant-handoff-lead">· leads</em>}
                {checked && !isLead && typedOrder.indexOf(agent) > 0 && <em className="assistant-handoff-order">· #{typedOrder.indexOf(agent) + 1}</em>}
              </label>
            </li>
          );
        })}
      </ul>
      {preview && <div className="assistant-handoff-preview" role="status">{preview}</div>}
      <div className="assistant-handoff-clarify-actions">
        {!isFirstQuestion && <button type="button" onClick={() => onBack?.()}>Back</button>}
        <button type="button" className="primary" disabled={!typedOrder.length} onClick={() => onStart(typedOrder)}>Start with {typedOrder.length || 1} agent{typedOrder.length === 1 ? '' : 's'}</button>
      </div>
      <div className="assistant-handoff-hint">Enter ticks a name. ⌘↵ or Ctrl+↵ starts.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paused question handling — explicit Continue/Stop only
// ---------------------------------------------------------------------------
export function PausedQuestion({
  workerName,
  questionText,
  questionId,
  taskRev,
  onContinue,
  onStop,
  onAsk,
}: {
  workerName: string;
  questionText: string;
  questionId: string;
  taskRev: number;
  onContinue: (questionId: string, rev: number) => void;
  onStop: (questionId: string, rev: number) => void;
  onAsk: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    // Only the authenticated host may classify a free-text control.
    onAsk(t);
    setDraft('');
  };

  return (
    <div className="assistant-handoff-paused" data-question-id={questionId}>
      <div className="assistant-handoff-paused-head">Waiting for you · {workerName}: {questionText}</div>
      <div className="assistant-handoff-paused-actions">
        <button type="button" className="primary" onClick={() => onContinue(questionId, taskRev)}>Keep going</button>
        <button type="button" onClick={() => onStop(questionId, taskRev)}>Stop here</button>
      </div>
      <div className="assistant-handoff-composer">
        <input type="text" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ask about step 12, or say Keep going / Stop here" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        <button type="button" onClick={submit}>Send</button>
      </div>
      <div className="assistant-handoff-hint">Closing this or typing anything else leaves {workerName} waiting.</div>
    </div>
  );
}

// Utility for typed agent order preservation used by conversation parser
export { preserveTypedAgentOrder, classifyPlainHandoffReply };


export function HandoffDraftView({draft, lane}: {draft: PendingHandoff; lane: PersonalLane}) {
  const [options, setOptions] = useState<HandoffOptions | null>(null);
  const [workers, setWorkers] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true; setOptions(null); setProblem(''); setWorkers(draft.destination?.workers ?? []);
    lane.handoffOptions?.(draft.id).then(value => { if (current) setOptions(value); }).catch(error => { if (current) setProblem(String(error)); });
    return () => { current = false; };
  }, [draft.id, draft.revision, lane.ref?.hostId, lane.ref?.assistantId]);
  const select = async (selection: HandoffSelection) => {
    if (busy || !lane.handoffSelect) return; setBusy(true); setProblem('');
    try { await lane.handoffSelect(draft, selection); } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  return <section className="assistant-handoff-clarify" aria-label="Finish choosing where to hand off your request" aria-busy={busy}>
    <p>{draft.originalRequest}</p>
    {problem && <p role="alert">{problem}</p>}
    {!options ? <p>Loading saved choices…</p> : <fieldset disabled={busy || lane.offline}>
      {draft.missing === 'project' && <><legend>Which project?</legend>{options.projects.map(choice => <button key={choice.project.workspaceId} type="button" onClick={() => void select({project:{project:choice.project}})}>{choice.label}</button>)}</>}
      {draft.missing === 'thread' && <><button type="button" onClick={() => void select('back')}>Back</button><legend>Existing thread or a new thread?</legend>{options.threads.map(choice => <button key={choice.id} type="button" onClick={() => void select({thread:{thread_id:choice.id}})}>{choice.title}</button>)}<label>New thread title<input value={title} onChange={event => setTitle(event.target.value)} /></label><button type="button" disabled={!title.trim()} onClick={() => void select({newThread:{title:title.trim()}})}>Use a new thread</button></>}
      {draft.missing === 'workers' && <AgentClarification allAgents={options.workers.map(w => w.id)} agentNames={Object.fromEntries(options.workers.map(w => [w.id,w.name]))} typedOrder={workers} onOrderChange={setWorkers} onStart={ids => void select({workers:{worker_ids:ids}})} onBack={() => void select("back")} />}
    </fieldset>}
  </section>;
}

export function HandoffTaskQuestion({task, lane}: {task: AssistantTask; lane: PersonalLane}) {
  const [question, setQuestion] = useState<HandoffQuestion | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true; setQuestion(null);
    if (task.status === 'needs_you' || task.resultData?.pendingQuestions?.length) lane.handoffQuestion?.(task.id).then(value => { if(current) setQuestion(value); }).catch(error => { if(current) setProblem(String(error)); });
    return () => {current = false;};
  }, [task.id, task.revision, lane.ref?.hostId, lane.ref?.assistantId]);
  if (!question) return problem ? <p role="alert">{problem}</p> : null;
  const control = async (action: 'continue' | 'stop') => {
    if (busy || !lane.handoffControl) return; setBusy(true); setProblem('');
    try { await lane.handoffControl({taskId:task.id,expectedTaskRevision:task.revision,action,questionId:question.questionId,expectedQuestionRevision:question.questionRevision}); } catch(error) {setProblem(error instanceof Error ? error.message : String(error));} finally {setBusy(false);}
  };
  return <fieldset disabled={busy || lane.offline}>
    {problem && <p role="alert">{problem}</p>}
    {question.canContinue ? <PausedQuestion workerName={question.workerName} questionText={question.text} questionId={question.questionId} taskRev={task.revision} onContinue={() => void control('continue')} onStop={() => void control('stop')} onAsk={text => void lane.send(text).catch(error => setProblem(String(error)))} /> : <p>Waiting for you · {question.workerName}: {question.text}</p>}
  </fieldset>;
}


export function HandoffControlConfirmationView({pending, lane}: {pending: PendingControlConfirmation; lane: PersonalLane}) {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (dismissed) return null;
  const confirm = async () => {
    if (busy || !lane.handoffControl) return; setBusy(true); setProblem('');
    try {
      await lane.handoffControl({taskId:pending.binding.taskId,expectedTaskRevision:pending.expectedTaskRevision,action:pending.action,confirmation:pending.binding,...(pending.binding.questionId ? {questionId:pending.binding.questionId,expectedQuestionRevision:pending.binding.questionRevision}: {})});
      setDismissed(true);
    } catch(error) {setProblem(error instanceof Error ? error.message : String(error));} finally {setBusy(false);}
  };
  return <section className="assistant-handoff-paused" aria-label="Confirm task control">
    <p>{pending.label}</p>{problem && <p role="alert">{problem}</p>}
    <button type="button" disabled={busy || lane.offline} onClick={() => void confirm()}>Confirm</button>
    <button type="button" disabled={busy} onClick={() => setDismissed(true)}>Leave it waiting</button>
  </section>;
}
