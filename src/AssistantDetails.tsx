// The assistant's Details tab: who it is, what needs you, what it has been
// doing, what it made for you, and the way into its sections. It renders in the
// app's one side panel — nothing here opens a second sidebar or a pop-up.

import { useState } from 'react';
import type { PersonalLane } from './personalAssistant';
import type { AssistantTask } from './assistantTaskModel';
import { assistantAppearance } from './assistantIdentity';
import { Avatar } from './Avatar';
import { OUTPUT_LABEL, OUTPUT_MARK, outputsLine, previewSource, type AssistantOutput } from './assistantOutputs';
import type { AssistantSection } from './assistantWorkspaceModel';
import './assistant-details.css';

/** Statuses that are sitting on the human's answer or a look at the result. */
const WAITING = new Set(['proposed', 'needs_clarification', 'needs_you', 'ready_for_review']);
const WORKING = new Set(['queued', 'running', 'applying']);

/** One short line for a task row. */
export function activityLine(status: string): string {
  if (status === 'ready_for_review') return 'Ready to review';
  if (status === 'needs_you' || status === 'needs_clarification' || status === 'proposed') return 'Waiting on you';
  if (status === 'done') return 'Done';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'interrupted') return 'Interrupted';
  return 'Working';
}

/** A shape, not just a colour, so the row reads without seeing green from amber. */
export function activityMark(status: string): string {
  if (status === 'done') return '✓';
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return '×';
  return WORKING.has(status) ? '○' : '!';
}

export function taskTitle(task: Pick<AssistantTask, 'brief' | 'originalRequest'>): string {
  const first = (task.brief || task.originalRequest || '').trim().split('\n')[0].trim();
  return first.length > 0 ? first : 'Untitled task';
}

/** "Today 2:14 PM", "Yesterday 9:05 AM", else "Oct 22". Empty for a missing time. */
export function whenLabel(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const sameDay = (other: Date) => date.getFullYear() === other.getFullYear() && date.getMonth() === other.getMonth() && date.getDate() === other.getDate();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(new Date(now))) return `Today ${time}`;
  if (sameDay(new Date(now - 86_400_000))) return `Yesterday ${time}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Worked for 4m", "Worked for 1h 20m"; empty when the record has no span. */
export function workedFor(createdMs: number, updatedMs: number): string {
  const span = updatedMs - createdMs;
  if (!Number.isFinite(span) || span <= 0) return '';
  const minutes = Math.max(1, Math.round(span / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function AssistantDetails({ lane, tasks = [], outputs, outputsLoading = false, outputsProblem = '', onClose, onNavigate, onOpenBrowser, onOpenFile, onGoToChat }: {
  lane: PersonalLane;
  tasks?: AssistantTask[];
  outputs: AssistantOutput[];
  outputsLoading?: boolean;
  outputsProblem?: string;
  onClose: () => void;
  onNavigate: (section: AssistantSection) => void;
  onOpenBrowser?: () => void;
  onOpenFile?: (path: string, cwd: string | null) => void;
  onGoToChat?: (taskId: string) => void;
}) {
  const record = lane.assistant;
  const ref = lane.ref ?? { hostId: record?.hostId ?? lane.hostName, assistantId: record?.id ?? lane.name };
  const look = assistantAppearance(ref, record?.look);
  /** Which folds are closed. Nothing starts folded. */
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  /** The one output whose text is showing. */
  const [shownOutput, setShownOutput] = useState<string | null>(null);
  /** The task whose activity detail is showing, if any. */
  const [openedTask, setOpenedTask] = useState<string | null>(null);
  const fold = (name: string) => (folded[name] ? {} : { open: true });
  const toggle = (name: string) => setFolded((now) => ({ ...now, [name]: !now[name] }));

  const needs = tasks.filter((task) => WAITING.has(task.status));
  const recent = [...tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, 12);
  const detail = openedTask ? tasks.find((task) => task.id === openedTask) ?? null : null;

  return (
    <div className="assistant-details">
      <header className="assistant-details-head">
        <Avatar seed={look.seed} color={look.color} image={look.kind === 'image' ? look.image : undefined} assistant={ref} size="lg" />
        <div className="assistant-details-id">
          <h2 className="assistant-details-name">{lane.name}</h2>
          <p className="assistant-details-role">Apex assistant</p>
        </div>
        <button type="button" className="assistant-details-close" aria-label="Close details" onClick={onClose}>×</button>
      </header>

      <div className="assistant-details-body">
        {detail ? (
          <section className="assistant-activity-detail" aria-label={`${taskTitle(detail)} detail`}>
            <button type="button" className="assistant-details-back" onClick={() => setOpenedTask(null)}>‹ Recent activity</button>
            <h3 className="assistant-activity-title">{taskTitle(detail)}</h3>
            <p className="assistant-details-note">You asked{whenLabel(detail.createdAtMs) ? ` · ${whenLabel(detail.createdAtMs)}` : ''}</p>
            <p className="assistant-details-note">
              {activityLine(detail.status)}
              {workedFor(detail.createdAtMs, detail.updatedAtMs) ? ` · Worked for ${workedFor(detail.createdAtMs, detail.updatedAtMs)}` : ''}
            </p>
            {detail.result ? <p className="assistant-activity-result">{detail.result}</p> : null}
            <button type="button" className="assistant-details-action" onClick={() => onGoToChat?.(detail.id)}>Go to chat</button>
          </section>
        ) : (
          <>
            <section className="assistant-details-card">
              <h3 className="assistant-details-card-title">Browser</h3>
              <p className="assistant-details-note">{onOpenBrowser ? 'Opens beside this sidebar. Take over whenever you like.' : 'This machine does not show the assistant browser.'}</p>
              {onOpenBrowser ? <button type="button" className="assistant-details-action" onClick={onOpenBrowser}>Open browser</button> : null}
            </section>

            {needs.length > 0 ? (
              <section className="assistant-details-fold">
                <button type="button" className="assistant-details-fold-head" aria-expanded={!folded.needs} aria-controls="assistant-needs" onClick={() => toggle('needs')}>
                  <span className="assistant-details-fold-name">Needs you</span>
                  <span className="assistant-details-fold-count">{needs.length}</span>
                  <span className="assistant-details-fold-arrow" aria-hidden="true">{folded.needs ? '▸' : '▾'}</span>
                </button>
                <div id="assistant-needs" className="assistant-details-fold-body" {...fold('needs')}>
                  {needs.map((task) => (
                    <button key={task.id} type="button" className="assistant-activity-row is-waiting" onClick={() => onGoToChat?.(task.id)}>
                      <span className="assistant-activity-mark" aria-hidden="true">{activityMark(task.status)}</span>
                      <span className="assistant-activity-text">
                        <span className="assistant-activity-name">{taskTitle(task)}</span>
                        <span className="assistant-activity-line">{activityLine(task.status)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="assistant-details-fold">
              <button type="button" className="assistant-details-fold-head" aria-expanded={!folded.activity} aria-controls="assistant-activity" onClick={() => toggle('activity')}>
                <span className="assistant-details-fold-name">Recent activity</span>
                <span className="assistant-details-fold-count">{tasks.length === 0 ? 'Nothing yet' : tasks.length}</span>
                <span className="assistant-details-fold-arrow" aria-hidden="true">{folded.activity ? '▸' : '▾'}</span>
              </button>
              <div id="assistant-activity" className="assistant-details-fold-body" {...fold('activity')}>
                {recent.length === 0 ? <p className="assistant-details-note">When you ask it to do something, it shows up here.</p> : null}
                {recent.map((task) => (
                  <button key={task.id} type="button" className="assistant-activity-row" onClick={() => setOpenedTask(task.id)}>
                    <span className="assistant-activity-mark" aria-hidden="true">{activityMark(task.status)}</span>
                    <span className="assistant-activity-text">
                      <span className="assistant-activity-name">{taskTitle(task)}</span>
                      <span className="assistant-activity-line">{activityLine(task.status)}{whenLabel(task.updatedAtMs) ? ` · ${whenLabel(task.updatedAtMs)}` : ''}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="assistant-details-fold">
              <button type="button" className="assistant-details-fold-head" aria-expanded={!folded.outputs} aria-controls="assistant-outputs" onClick={() => toggle('outputs')}>
                <span className="assistant-details-fold-name">Outputs</span>
                <span className="assistant-details-fold-count">{outputsLine(outputs)}</span>
                <span className="assistant-details-fold-arrow" aria-hidden="true">{folded.outputs ? '▸' : '▾'}</span>
              </button>
              <div id="assistant-outputs" className="assistant-details-fold-body" {...fold('outputs')}>
                {outputsLoading ? <p className="assistant-details-note" role="status">Reading this session’s outputs…</p> : null}
                {outputsProblem ? <p className="assistant-details-note" role="status">{outputsProblem}</p> : null}
                {!outputsLoading && !outputsProblem && outputs.length === 0 ? (
                  <p className="assistant-details-note">When a task writes a document, an export or a page, it appears here.</p>
                ) : null}
                {outputs.map((output) => {
                  const open = shownOutput === output.id;
                  return (
                    <div className="assistant-output" key={output.id}>
                      <button
                        type="button"
                        className="assistant-output-row"
                        aria-expanded={output.artifact ? open : undefined}
                        title={output.path ?? output.name}
                        onClick={() => {
                          if (output.artifact) setShownOutput(open ? null : output.id);
                          else if (output.path && onOpenFile) onOpenFile(output.path, output.cwd ?? null);
                        }}
                      >
                        <span className={`assistant-output-mark is-${output.kind}`} aria-hidden="true">{OUTPUT_MARK[output.kind]}</span>
                        <span className="assistant-output-text">
                          <span className="assistant-output-name">{output.name}</span>
                          <span className="assistant-output-where">
                            {output.folder ? `${output.folder} · ` : ''}
                            {OUTPUT_LABEL[output.kind]}
                            {output.artifact ? ` · v${output.artifact.versions.length}` : ''}
                          </span>
                        </span>
                      </button>
                      {open && output.artifact ? (
                        <pre className="assistant-output-source" aria-label={`${output.name} content`}>{previewSource(output.artifact)}</pre>
                      ) : null}
                    </div>
                  );
                })}
                <p className="assistant-details-footnote">From the threads these tasks worked in. Code changes stay in Review.</p>
              </div>
            </section>
          </>
        )}
      </div>

      <footer className="assistant-details-links">
        <button type="button" onClick={() => onNavigate('memory')}>Memory</button>
        <button type="button" onClick={() => onNavigate('projects')}>Projects &amp; access</button>
        <button type="button" onClick={() => onNavigate('settings')}>Settings</button>
      </footer>
    </div>
  );
}
