// The assistant's Details tab: who it is, what needs you, what it has been
// doing, what it made for you, and the way into its sections. It renders in the
// app's one side panel — nothing here opens a second sidebar or a pop-up.

import { useMemo, useState } from 'react';
import type { Backend } from './backend';
import type { PersonalLane, Schedule } from './personalAssistant';
import type { AssistantTask } from './assistantTaskModel';
import { assistantAppearance } from './assistantIdentity';
import { assistantStatus } from './assistantStatus';
import { createAssistantAvatarApi } from './assistantAvatar';
import { Avatar } from './Avatar';
import { AssistantAvatarEditor } from './AssistantAvatarEditor';
import { AssistantRuntimeSettings } from './AssistantRuntimeSettings';
import { AssistantReview } from './AssistantReview';
import { OUTPUT_LABEL, OUTPUT_MARK, outputsLine, previewSource, type AssistantOutput } from './assistantOutputs';
import type { AssistantSection } from './assistantWorkspaceModel';
import type { ParticipantConfig } from './types';
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

/** "Every 2h", "Daily at 09:00", else "Scheduled". */
export function scheduleLine(schedule: Pick<Schedule, 'everyMs' | 'dailyAt'>): string {
  const every = schedule.everyMs;
  if (typeof every === 'number' && Number.isFinite(every) && every > 0) {
    const minutes = Math.round(every / 60_000);
    if (minutes < 60) return `Every ${Math.max(1, minutes)}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Every ${hours}h`;
    return `Every ${Math.round(hours / 24)}d`;
  }
  if (typeof schedule.dailyAt === 'string' && schedule.dailyAt.trim()) return `Daily at ${schedule.dailyAt.trim()}`;
  return 'Scheduled';
}

/** The word under the name. "Active now" is the resting state. */
export function statusWord(state: string): string {
  if (state === 'offline') return 'Offline';
  if (state === 'paused') return 'Paused';
  if (state === 'working') return 'Working';
  if (state === 'needs_you' || state === 'failed') return 'Needs you';
  return 'Active now';
}

/** "Access · 2 projects" for the folded Model & access line. */
export function accessSummary(access?: string, projects?: number): string {
  const level = access === 'full' ? 'Full access' : access === 'read' ? 'Read only' : access === 'edits' ? 'Allow edits' : 'Ask first';
  const count = typeof projects === 'number' && projects > 0 ? projects : 0;
  return `${level} · ${count === 1 ? '1 project' : `${count} projects`}`;
}

export function AssistantDetails({ lane, backend, profiles = [], tasks = [], outputs, outputsLoading = false, outputsProblem = '', onClose, onNavigate, onOpenBrowser, onOpenBrowserTab, onRefresh, onOpenFile, onGoToChat, onStartCall }: {
  lane: PersonalLane;
  backend?: Backend;
  profiles?: ParticipantConfig[];
  tasks?: AssistantTask[];
  outputs: AssistantOutput[];
  outputsLoading?: boolean;
  outputsProblem?: string;
  onClose: () => void;
  onNavigate: (section: AssistantSection) => void;
  onOpenBrowser?: () => void;
  /** Opens the assistant's browser as a tab in this same sidebar (§5.3). */
  onOpenBrowserTab?: () => void;
  /** Re-reads the assistant's tasks after accepting or asking for changes. */
  onRefresh?: () => void;
  onOpenFile?: (path: string, cwd: string | null) => void;
  onGoToChat?: (taskId: string) => void;
  onStartCall?: () => void;
}) {
  const record = lane.assistant;
  const ref = lane.ref ?? { hostId: record?.hostId ?? lane.hostName, assistantId: record?.id ?? lane.name };
  const look = assistantAppearance(ref, record?.look);
  const avatarApi = useMemo(() => (backend ? createAssistantAvatarApi(backend) : undefined), [backend]);
  /** Which folds are closed. Model & access starts folded; the rest start open. */
  const [folded, setFolded] = useState<Record<string, boolean>>({ model: true });
  /** The one output whose text is showing. */
  const [shownOutput, setShownOutput] = useState<string | null>(null);
  /** The task whose activity detail is showing, if any. */
  const [openedTask, setOpenedTask] = useState<string | null>(null);
  /** The task whose result is being reviewed inside this tab (§5.4). */
  const [reviewTask, setReviewTask] = useState<string | null>(null);
  /** Whether the pencil's avatar editor is showing. */
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  /** The schedule being cancelled, so its button cannot fire twice. */
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState('');
  const toggle = (name: string) => setFolded((now) => ({ ...now, [name]: !now[name] }));

  const status = assistantStatus({ offline: !!lane.offline, paused: !!record?.paused, personalTasks: record?.tasks ?? [], delegatedTasks: tasks });
  const needs = tasks.filter((task) => WAITING.has(task.status));
  const recent = [...tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, 12);
  const detail = openedTask ? tasks.find((task) => task.id === openedTask) ?? null : null;
  /** The result being reviewed, if the sidebar is showing one instead of the overview. */
  const reviewing = reviewTask ? tasks.find((task) => task.id === reviewTask) ?? null : null;
  const schedules = record?.schedules ?? [];
  const activeSchedules = schedules.filter((schedule) => schedule.status === 'active');
  const draftSchedules = schedules.filter((schedule) => schedule.status === 'proposed');
  const runtimeReady = !!backend && !!record?.profile;
  const modelName = record?.profile?.backend?.kind === 'agent' || record?.profile?.backend?.kind === 'open_ai_compatible' ? record.profile.backend.model ?? 'Provider default' : 'Provider default';

  const cancelSchedule = async (schedule: Schedule) => {
    if (!lane.cancelSchedule || cancelling) return;
    setCancelling(schedule.id);
    setScheduleError('');
    try {
      await lane.cancelSchedule(schedule.id);
    } catch (cause) {
      setScheduleError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCancelling(null);
    }
  };

  const applyAvatar = async (selection: Parameters<NonNullable<React.ComponentProps<typeof AssistantAvatarEditor>['onApply']>>[0]) => {
    if (!lane.configureWorkspace || !record) return;
    setAvatarError('');
    try {
      await lane.configureWorkspace({ expectedRevision: record.revision, avatar: selection });
      setAvatarOpen(false);
    } catch (cause) {
      setAvatarError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="assistant-details">
      <header className="assistant-details-head">
        <div className="assistant-details-portrait">
          <Avatar seed={look.seed} color={look.color} image={look.kind === 'image' ? look.image : undefined} assistant={ref} avatarApi={avatarApi} size="lg" />
          <button
            type="button"
            className="assistant-details-pencil"
            aria-label={`Change ${lane.name}’s avatar`}
            aria-expanded={avatarOpen}
            aria-controls="assistant-details-avatar"
            title="Change avatar"
            onClick={() => setAvatarOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z" /></svg>
          </button>
        </div>
        <div className="assistant-details-id">
          <h2 className="assistant-details-name" title={lane.name}>{lane.name}</h2>
          <p className="assistant-details-role" data-state={status.state}>{statusWord(status.state)}</p>
        </div>
        <button type="button" className="assistant-details-close" aria-label="Close details" onClick={onClose}>×</button>
      </header>

      {avatarOpen ? (
        <div id="assistant-details-avatar" className="assistant-details-avatar-editor">
          <AssistantAvatarEditor
            owner={{ kind: 'assistant', assistant: ref }}
            api={avatarApi}
            appearance={look}
            onAppearanceChange={() => {}}
            onApply={(selection) => void applyAvatar(selection)}
            disabled={lane.offline}
          />
          {avatarError ? <p className="assistant-details-note" role="alert">{avatarError}</p> : null}
          <button type="button" className="assistant-details-action" onClick={() => setAvatarOpen(false)}>Close editor</button>
        </div>
      ) : null}

      <div className="assistant-details-body">
        {reviewing ? (
          backend ? <AssistantReview task={reviewing} name={lane.name} backend={backend} onBack={() => setReviewTask(null)} onDone={() => { setReviewTask(null); setOpenedTask(null); onRefresh?.(); }} />
            : <p className="assistant-details-note">Reconnect this machine to review this result.</p>
        ) : detail ? (
          <section className="assistant-activity-detail" aria-label={`${taskTitle(detail)} detail`}>
            <button type="button" className="assistant-details-back" onClick={() => setOpenedTask(null)}>‹ Recent activity</button>
            <h3 className="assistant-activity-title">{taskTitle(detail)}</h3>
            <p className="assistant-details-note">You asked{whenLabel(detail.createdAtMs) ? ` · ${whenLabel(detail.createdAtMs)}` : ''}</p>
            <p className="assistant-details-note">
              {activityLine(detail.status)}
              {workedFor(detail.createdAtMs, detail.updatedAtMs) ? ` · Worked for ${workedFor(detail.createdAtMs, detail.updatedAtMs)}` : ''}
            </p>
            {detail.result ? <p className="assistant-activity-result">{detail.result}</p> : null}
            <div className="assistant-details-row">
              {detail.status === 'ready_for_review' ? <button type="button" className="assistant-details-action" onClick={() => setReviewTask(detail.id)}>Review changes</button> : null}
              <button type="button" className="assistant-details-action" onClick={() => onGoToChat?.(detail.id)}>Go to chat</button>
            </div>
          </section>
        ) : (
          <>
            <div className="assistant-details-row">
              <button type="button" className="assistant-details-action" disabled={!onStartCall} title={onStartCall ? undefined : 'Calling needs this machine connected.'} onClick={() => onStartCall?.()}>Call</button>
            </div>

            <section className="assistant-details-card">
              <h3 className="assistant-details-card-title">Browser</h3>
              <p className="assistant-details-note">{onOpenBrowserTab || onOpenBrowser ? 'Ready · Opens as a tab beside Details.' : 'This machine does not show the assistant browser.'}</p>
              {onOpenBrowserTab || onOpenBrowser ? <button type="button" className="assistant-details-action" onClick={() => (onOpenBrowserTab ?? onOpenBrowser)?.()}>Open browser</button> : null}
            </section>

            <section className="assistant-details-fold">
              <button type="button" className="assistant-details-fold-head" aria-expanded={!folded.model} aria-controls="assistant-model" onClick={() => toggle('model')}>
                <span className="assistant-details-fold-name">Model &amp; access</span>
                <span className="assistant-details-fold-count" title={runtimeReady ? `${modelName} · ${accessSummary(record?.profile?.access, record?.projects?.length)}` : undefined}>
                  {runtimeReady ? `· ${accessSummary(record?.profile?.access, record?.projects?.length)}` : 'Not ready'}
                </span>
                <span className="assistant-details-fold-arrow" aria-hidden="true">{folded.model ? '▸' : '▾'}</span>
              </button>
              <div id="assistant-model" className="assistant-details-fold-body" hidden={!!folded.model}>
                {folded.model ? null : runtimeReady ? (
                  <AssistantRuntimeSettings inline lane={lane} backend={backend} profiles={profiles} close={() => setFolded((now) => ({ ...now, model: true }))} onSettings={() => onNavigate('settings')} />
                ) : (
                  <p className="assistant-details-note">{backend ? 'Open Settings to choose a compatible text provider.' : 'Reconnect this machine to configure the runtime.'}</p>
                )}
              </div>
            </section>

            {needs.length > 0 ? (
              <section className="assistant-details-fold">
                <button type="button" className="assistant-details-fold-head" aria-expanded={!folded.needs} aria-controls="assistant-needs" onClick={() => toggle('needs')}>
                  <span className="assistant-details-fold-name">Needs you</span>
                  <span className="assistant-details-fold-count">{needs.length}</span>
                  <span className="assistant-details-fold-arrow" aria-hidden="true">{folded.needs ? '▸' : '▾'}</span>
                </button>
                <div id="assistant-needs" className="assistant-details-fold-body" hidden={!!folded.needs}>
                  {needs.map((task) => (
                    <button key={task.id} type="button" className="assistant-activity-row is-waiting" onClick={() => (task.status === 'ready_for_review' ? setReviewTask(task.id) : onGoToChat?.(task.id))}>
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
              <button type="button" className="assistant-details-fold-head" aria-expanded={!folded.schedules} aria-controls="assistant-schedules" onClick={() => toggle('schedules')}>
                <span className="assistant-details-fold-name">Schedules</span>
                <span className="assistant-details-fold-count">{activeSchedules.length === 0 ? 'None' : activeSchedules.length}</span>
                <span className="assistant-details-fold-arrow" aria-hidden="true">{folded.schedules ? '▸' : '▾'}</span>
              </button>
              <div id="assistant-schedules" className="assistant-details-fold-body" hidden={!!folded.schedules}>
                {scheduleError ? <p className="assistant-details-note" role="alert">{scheduleError}</p> : null}
                {activeSchedules.length === 0 ? (
                  <p className="assistant-details-note">{draftSchedules.length > 0 ? 'One draft is waiting for you in chat.' : 'No schedules. Ask in chat to set one up.'}</p>
                ) : null}
                {activeSchedules.map((schedule) => (
                  <div className="assistant-schedule" key={schedule.id}>
                    <span className="assistant-schedule-text">
                      <span className="assistant-schedule-goal" title={schedule.goal}>{schedule.goal}</span>
                      <span className="assistant-schedule-line">{scheduleLine(schedule)}{schedule.nextAt ? ` · Next ${whenLabel(schedule.nextAt)}` : ''}</span>
                    </span>
                    <button type="button" className="assistant-schedule-cancel" disabled={!lane.cancelSchedule || cancelling === schedule.id} onClick={() => void cancelSchedule(schedule)}>{cancelling === schedule.id ? 'Cancelling…' : 'Cancel'}</button>
                  </div>
                ))}
              </div>
            </section>

            <section className="assistant-details-fold">
              <button type="button" className="assistant-details-fold-head" aria-expanded={!folded.activity} aria-controls="assistant-activity" onClick={() => toggle('activity')}>
                <span className="assistant-details-fold-name">Recent activity</span>
                <span className="assistant-details-fold-count">{tasks.length === 0 ? 'Nothing yet' : tasks.length}</span>
                <span className="assistant-details-fold-arrow" aria-hidden="true">{folded.activity ? '▸' : '▾'}</span>
              </button>
              <div id="assistant-activity" className="assistant-details-fold-body" hidden={!!folded.activity}>
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
              <div id="assistant-outputs" className="assistant-details-fold-body" hidden={!!folded.outputs}>
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
                <p className="assistant-details-footnote">From this chat and the threads its tasks worked in. Code changes stay in Review.</p>
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
