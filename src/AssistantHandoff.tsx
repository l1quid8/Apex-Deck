/**
 * Task 7: Slim handoff pill, read-only popover, clarification UI
 * - One sentence + small pill + hover/focus Stop (quiet, same height)
 * - View-only 40-cell tape popover (Round1: Try again only, no branch)
 * - Ordered agent/team with lead badge, preview before Start
 * - No ghost horizon colored border, fixed 24px composer auxiliary space handled by parent
 */
import { forwardRef, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AssistantTask } from './assistantTaskModel';
import { deriveHandoffPill, deriveHandoffPopover, classifyPlainHandoffReply, preserveTypedAgentOrder, type TaskConversationProgress, type TaskConversationEvent } from './assistantHandoffModel';

export function HandoffPillView({
  task,
  progress,
  threadLabel,
  onStop,
  onRetry,
  onOpen,
}: {
  task: AssistantTask;
  progress?: TaskConversationProgress;
  threadLabel?: string;
  onStop?: (taskId: string, revision: number) => void;
  onRetry?: (taskId: string, revision: number) => void;
  onOpen?: (taskId: string) => void;
}) {
  const pill = deriveHandoffPill(task, progress, threadLabel);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Close on outside / Esc
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node) && anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const showStop = pill.availableActions.includes('stop');

  return (
    <span className="assistant-handoff-line">
      <span className="assistant-handoff-sentence">{pill.sentence}</span>{' '}
      <span className="assistant-handoff-pill-wrap" ref={anchorRef}>
        <button
          type="button"
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
          events={[]}
          onClose={() => setOpen(false)}
          onRetry={() => { onRetry?.(pill.taskId, pill.revision); setOpen(false); }}
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
  onClose: () => void;
  onRetry: () => void;
  onOpenTask: () => void;
};

const HandoffPopoverImpl = forwardRef<HTMLDivElement, PopoverProps>(function HandoffPopoverImpl(
  { task, progress, events, onClose, onRetry, onOpenTask },
  ref
) {
  const model = deriveHandoffPopover(task, progress, events);
  const [selectedIndex, setSelectedIndex] = useState(model.currentIndex);

  // Keep selected in bounds when task updates
  useEffect(() => { setSelectedIndex(model.currentIndex); }, [model.currentIndex, model.taskId]);

  const selectedStep = model.steps.find(s => s.index === selectedIndex);

  return (
    <div className="assistant-handoff-popover" role="dialog" aria-label={`Progress for ${task.brief.slice(0, 60)}`} ref={ref}>
      <div className="assistant-handoff-popover-head">
        <strong>{model.steps.length ? `${model.steps.filter(s => s.state === 'done').length} of ${model.steps.length} done` : 'Working'}</strong>
        <button type="button" className="assistant-handoff-close" aria-label="Close details" onClick={onClose}>✕</button>
      </div>

      {model.steps.length > 0 && (
        <div className="assistant-handoff-tape" role="group" aria-label="Execution steps">
          {model.steps.map(step => (
            <button
              key={step.index}
              type="button"
              className={`assistant-handoff-cell ${step.state}${selectedIndex === step.index ? ' is-selected' : ''}`}
              aria-label={`Step ${step.index}${step.state === 'done' ? ' done' : step.state === 'active' ? ' active' : ''}`}
              onClick={() => setSelectedIndex(step.index)}
            />
          ))}
        </div>
      )}

      {selectedStep && (
        <div className="assistant-handoff-step-detail">
          <div className="assistant-handoff-step-title">Step {selectedStep.index}{selectedStep.state === 'done' ? ' · done' : selectedStep.state === 'active' ? ' · running' : ' · queued'}</div>
          {selectedStep.text && <div className="assistant-handoff-step-text">{selectedStep.text}</div>}
          {!selectedStep.text && <div className="assistant-handoff-step-text">No output recorded for this step.</div>}
        </div>
      )}

      <div className="assistant-handoff-actions">
        {model.canRetry && <button type="button" className="primary" onClick={onRetry}>Try again</button>}
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
  typedOrder,
  onOrderChange,
  onStart,
  onBack,
  questionId,
  isFirstQuestion,
}: {
  allAgents: string[];
  typedOrder: string[]; // ordered distinct
  onOrderChange: (ordered: string[]) => void;
  onStart: (ordered: string[]) => void;
  onBack?: () => void;
  questionId?: string;
  isFirstQuestion?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const [highlight, setHighlight] = useState(0);

  const filtered = allAgents.filter(a => a.toLowerCase().includes(filter.toLowerCase()));
  const preview = typedOrder.length ? `${typedOrder.join(' + ')} · ${typedOrder[0]} leads` : '';

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
                <span>{agent}</span>
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
    const kind = classifyPlainHandoffReply(t);
    if (kind === 'continue') { onContinue(questionId, taskRev); setDraft(''); return; }
    if (kind === 'stop') { onStop(questionId, taskRev); setDraft(''); return; }
    // Anything else stays visible, worker stays waiting, conversational answer
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
