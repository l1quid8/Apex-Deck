import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Markdown } from './Markdown';
import './apex-agent-panel.css';
import './assistant-tasks.css';
import './apex-agent-dock.css';
import type { ToolServer, Workspace } from './types';
import { laneMentions, mentionedLane, mentionsAll, mergeProjectConversations, replyTarget, type MonitorEvidence, type ProjectMonitor } from './apexAgentModel.ts';
import { TaskViewContext, personalTaskGroup, personalTaskKey, type TaskGroup, type TaskSummary } from './apexAgentTaskView.ts';
import type { PersonalLane, PersonalMessage, PersonalTask } from './personalAssistant.ts';
import { PersonalPanels, type PanelName } from './PersonalPanels.tsx';
import './personal-panels.css';
import { PersonalCall } from './PersonalCall.tsx';
import './personal-call.css';
import { ApexAgentMessageActions, ApexAgentReplyQuote } from './ApexAgentMessageActions.tsx';
import type { MessageQuote, MessageReaction } from './apexAgentModel.ts';
import { messageStateKey, retryMessageText } from './apexAgentMessageControls.ts';
import { formatApexAgentQuote } from './apexAgentQuote.ts';
import { ApexAgentComposerTools, type ApexAgentComposerToolsHandle } from './ApexAgentComposerTools.tsx';
import { findTrigger } from './composerMenu.ts';
import type { ComposerMenuHandle } from './ComposerTools.tsx';
import type { Command } from './commands.ts';
import { parseComposer } from './commands.ts';

export type ApexAgentTaskContext = { id: string; project: string; label: string; send: (text: string) => Promise<void> };

const DAY = 24 * 60 * 60 * 1000;
/** The personal assistant's lane in the conversation. No workspace uses this id. */
const PERSONAL = 'personal';
const PERSONAL_STATUS: Record<string, string> = { needsYou: 'Needs you', queued: 'Approved', running: 'Running', waiting: 'Waiting', blocked: 'Blocked', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const everyText = (ms: number) => `every ${Math.round(ms / 60000)} min`;
const whenText = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Reuse the app's Markdown renderer for replies; only web links open externally.
const openMessageLink = (target: string) => {
  if (/^https?:\/\//i.test(target)) window.open(target, '_blank', 'noopener,noreferrer');
};

/** Text with ``` fences shown as preformatted blocks. */
function fenced(text: string) {
  return text.split('```').map((part, index) => index % 2 ? (part.trim() ? <pre key={index}>{part.replace(/^\n/, '').replace(/\n$/, '')}</pre> : null) : part.trim() ? <p key={index}>{part.trim()}</p> : null);
}

function evidenceList(items: MonitorEvidence[], open?: (item: MonitorEvidence) => void) {
  if (!items.length) return null;
  return <ul className="apex-agent-all-evidence">{items.map((item, index) => <li key={index}><button type="button" onClick={() => open?.(item)} disabled={!open}><strong>{item.label}</strong></button>{item.excerpt && <span> · “{item.excerpt}”</span>}</li>)}</ul>;
}

/** One conversation across every watched project. Replies go to the project they name, or the last one discussed. */
export function ApexAgentAll({ workspaces, monitors, onReply, onMutate, onSetUp, onClose, onHide, onCustomize, clearedAt = 0, onClear, fullScreen = false, onFullScreen, offlineWorkspaceIds = [], onOpenEvidence, onOverview, overviewEntries = [], tasks, taskNodes, filterWorkspaceId = null, onClearFilter, taskContext = null, onClearTaskContext, personal = null, onReact, saveAttachment, pickAttachmentFolder, pickFolderUnavailableReason, serversByLane = {}, serverStatusByLane = {}, onCommand }: {
  /** The personal assistant on its durable host, shown as one more lane in this conversation. */
  personal?: PersonalLane | null;
  onReact?: (workspaceId: string, messageId: string, emoji: MessageReaction, enabled: boolean) => Promise<void>;
  saveAttachment?: (laneId: string, name: string, bytes: Uint8Array) => Promise<string>;
  pickAttachmentFolder?: (laneId: string) => Promise<string | null>;
  pickFolderUnavailableReason?: string;
  serversByLane?: Record<string, (ToolServer & { agent: string })[]>;
  serverStatusByLane?: Record<string, string>;
  onCommand?: (command: Command, laneId: string) => void | Promise<void>;
  offlineWorkspaceIds?: string[];
  onOpenEvidence?: (workspaceId: string, evidence: MonitorEvidence) => Promise<void>;
  onOverview?: (text: string) => Promise<void>;
  overviewEntries?: (ReturnType<typeof mergeProjectConversations>[number] & { citations?: { workspaceId: string; evidence: MonitorEvidence }[] })[];
  /** Task cards for every watched project, used when `taskNodes` is not given. */
  tasks?: ReactNode;
  /** Task cards tagged with their project, so a filtered view can show only that project's cards. */
  taskNodes?: { workspaceId: string; node: ReactNode }[];
  /** When set, the conversation shows only this project. The personal assistant lane is hidden while filtering. */
  filterWorkspaceId?: string | null;
  onClearFilter?: () => void;
  taskContext?: ApexAgentTaskContext | null;
  onClearTaskContext?: () => void;
  workspaces: Workspace[];
  monitors: ProjectMonitor[];
  onReply: (workspaceId: string, text: string) => Promise<void>;
  onMutate: (workspaceId: string, command: string, args: Record<string, unknown>) => Promise<void>;
  onSetUp: (workspaceId: string) => void;
  onClose: () => void;
  onHide?: () => void;
  onCustomize?: () => void;
  /** Messages at or before this time are hidden; each project's assistant still remembers them. */
  clearedAt?: number;
  onClear?: () => void;
  fullScreen?: boolean;
  onFullScreen?: () => void;
}) {
  const names = useMemo(() => Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces]);
  const watched = workspaces.filter((workspace) => monitors.some((monitor) => monitor.workspaceId === workspace.id));
  const assistant = personal?.assistant ?? null;
  const personalTag = personal ? `${personal.name} · ${personal.hostName}` : '';
  // Projects plus the personal assistant: a reply goes to whichever is named, or the last one discussed.
  const lanes = [...watched.map((workspace) => ({ id: workspace.id, name: workspace.name })), ...(assistant ? [{ id: PERSONAL, name: personal!.name }] : [])];
  const laneNames: Record<string, string> = assistant ? { ...names, [PERSONAL]: personalTag } : names;
  const personalEntries = useMemo(() => (assistant?.messages ?? []).map((item: PersonalMessage) => ({
    workspaceId: PERSONAL, project: personalTag, personal: item,
    message: { id: item.id, role: item.role === 'human' ? 'human' : 'assistant', text: item.text, at: item.at, evidence: [] as MonitorEvidence[], reactions: item.reactions },
  })), [assistant, personalTag]);
  const allEntries = useMemo(() => [...mergeProjectConversations(monitors, names), ...overviewEntries, ...personalEntries].sort((a, b) => a.message.at - b.message.at), [monitors, names, overviewEntries, personalEntries]);
  const entries = useMemo(() => allEntries.filter((entry) => entry.message.at > clearedAt && (!filterWorkspaceId || entry.workspaceId === filterWorkspaceId) && !('personal' in entry && entry.personal.kind === 'notice')), [allEntries, clearedAt, filterWorkspaceId]);
  // Only the filtered project's findings and failed checks show while filtering.
  const inView = (workspaceId: string) => !filterWorkspaceId || workspaceId === filterWorkspaceId;
  const now = Date.now();
  const findings = monitors.flatMap((monitor) => monitor.findings
    .filter((finding) => finding.status === 'open' && !(finding.snoozedUntil && finding.snoozedUntil > now))
    .map((finding) => ({ workspaceId: monitor.workspaceId, finding })))
    .filter((item) => inView(item.workspaceId));
  const shownTasks = taskNodes ? (filterWorkspaceId ? taskNodes.filter((item) => item.workspaceId === filterWorkspaceId) : taskNodes).map((item) => item.node) : tasks;
  const filterName = filterWorkspaceId ? names[filterWorkspaceId] ?? 'Project' : '';
  const [text, setText] = useState('');
  const [replyQuotes, setReplyQuotes] = useState<(MessageQuote & { laneId: string })[]>([]);
  /** A second Reply stacks instead of replacing; exact duplicates are ignored. The first quote fixes the lane. */
  const addReplyQuote = (quote: MessageQuote & { laneId: string }) => {
    setReplyQuotes((list) => list.some((item) => item.messageId === quote.messageId && item.laneId === quote.laneId && item.text === quote.text) ? list : [...list, quote]);
    setDraftTaskContext(null); onClearTaskContext?.(); setFocus(quote.laneId); setDraftFallback(quote.laneId); requestAnimationFrame(() => composerInput.current?.focus());
  };
  const [attachmentState, setAttachmentState] = useState<{ paths: string[]; pending: boolean; hasErrors: boolean }>({ paths: [], pending: false, hasErrors: false });
  const [attachmentLane, setAttachmentLane] = useState<string | null>(null);
  const [draftTaskContext, setDraftTaskContext] = useState<ApexAgentTaskContext | null | undefined>(undefined);
  const selectedTaskContext = draftTaskContext === undefined ? taskContext : draftTaskContext;
  const [busy, setBusy] = useState(false);
  // Task cards whose details and history are expanded.
  const [openTasks, setOpenTasks] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  // The assistant's detail panels open as a sheet over the transcript.
  const [panelOpen, setPanelOpen] = useState<PanelName | null>(null);
  const [calling, setCalling] = useState(false);
  // One conversation, plus a Tasks view. Each project's task components report their rows here by store.
  const [view, setView] = useState<'chat' | 'tasks' | 'notifications'>('chat');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [placeFilter, setPlaceFilter] = useState<string | null>(null);
  const [reported, setReported] = useState<Record<string, TaskSummary[]>>({});
  const [noticesSeenThrough, setNoticesSeenThrough] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const composerMenu = useRef<ComposerMenuHandle | null>(null);
  const composerTools = useRef<ApexAgentComposerToolsHandle | null>(null);
  const [caret, setCaret] = useState(0);
  useEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  }, [text, view]);
  // Scroll positions are remembered per view; null means the chat has not been left yet.
  const chatScroll = useRef<number | null>(null);
  const tasksScroll = useRef(0);
  const notificationsScroll = useRef(0);
  const stateRef = useRef<{ view: 'chat' | 'tasks' | 'notifications'; selectedKey: string | null }>({ view: 'chat', selectedKey: null });
  stateRef.current = { view, selectedKey };
  const openPanel = (name: PanelName, event?: { currentTarget: EventTarget | null }) => {
    (event?.currentTarget as HTMLElement | null | undefined)?.closest?.('details')?.removeAttribute('open');
    setPanelOpen(name);
  };
  // The project a draft continues is fixed when typing starts, so a background message can't redirect it.
  const [draftFallback, setDraftFallback] = useState<string | null>(null);
  // Clear only hides messages, so the project last discussed is still taken from the full history.
  // While filtering, the filtered project is the default target.
  const lastSpoken = filterWorkspaceId ?? allEntries[allEntries.length - 1]?.workspaceId ?? null;
  const fallbackLane = filterWorkspaceId ?? focus ?? draftFallback ?? lastSpoken ?? (assistant ? PERSONAL : null);
  // The project the @ menu's handle names (see laneMentions), read like a room reads a mention.
  const laneHandles = laneMentions(lanes);
  const mentioned = mentionedLane(text, lanes);
  const target = replyQuotes[0]?.laneId ?? (filterWorkspaceId ? filterWorkspaceId : mentioned ?? replyTarget(text, lanes, fallbackLane));
  // Consume longer names first so "Mobile launch" does not also select "Mobile".
  let unmatched = text;
  const namedProjects = [...lanes].sort((a, b) => b.name.length - a.name.length).filter((workspace) => {
    const name = workspace.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${name}(?=$|[^\\p{L}\\p{N}_])`, 'giu');
    if (!pattern.test(unmatched)) return false;
    unmatched = unmatched.replace(pattern, ' '); return true;
  });
  const globalReply = !filterWorkspaceId && !replyQuotes.length && !attachmentLane && !!onOverview && (mentionsAll(text) || /\b(everywhere|all (?:my |the )?(?:projects|threads)|across (?:my |the )?projects|overall)\b/i.test(text) || namedProjects.length > 1 || (!mentioned && !namedProjects.length && (fallbackLane === '*' || !fallbackLane)));
  const bottom = useRef<HTMLDivElement | null>(null);
  // `busy` only updates on the next render; this blocks a second Enter pressed before then.
  const sending = useRef(false);
  useEffect(() => { if (stateRef.current.view === 'chat') bottom.current?.scrollIntoView?.({ block: 'end' }); }, [entries.length, findings.length]);
  // Returning to a view puts its list back where it was; a detail always starts at the top.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (view === 'chat') { if (chatScroll.current !== null) el.scrollTop = chatScroll.current; }
    else if (view === 'tasks') el.scrollTop = selectedKey ? 0 : tasksScroll.current;
    else el.scrollTop = notificationsScroll.current;
  }, [view, selectedKey]);
  const switchView = (next: 'chat' | 'tasks' | 'notifications') => {
    const current = stateRef.current;
    const top = scroller.current?.scrollTop ?? 0;
    if (current.view === 'chat') chatScroll.current = top;
    else if (current.view === 'tasks' && !current.selectedKey) tasksScroll.current = top;
    else if (current.view === 'notifications') notificationsScroll.current = top;
    if (next === 'notifications' && current.view !== 'notifications' && !filterWorkspaceId && personal?.seeNotices && (assistant?.notices ?? []).some((notice) => notice.deliveredAt && !notice.seenAt)) {
      const cutoff = Date.now();
      void run(async () => { await personal.seeNotices!(); setNoticesSeenThrough(cutoff); });
    }
    setView(next); setSelectedKey(null);
  };
  const openTask = useCallback((key: string) => {
    const current = stateRef.current;
    const top = scroller.current?.scrollTop ?? 0;
    if (current.view === 'chat') chatScroll.current = top;
    else if (current.view === 'tasks' && !current.selectedKey) tasksScroll.current = top;
    else if (current.view === 'notifications') notificationsScroll.current = top;
    setView('tasks'); setSelectedKey(key);
  }, []);
  // Rows are replaced per store. Identical rows keep the same state, so a store reporting on every render cannot loop.
  const report = useCallback((storeKey: string, rows: TaskSummary[]) => {
    setReported((current) => JSON.stringify(current[storeKey]) === JSON.stringify(rows) ? current : { ...current, [storeKey]: rows });
  }, []);
  const taskContextValue = useMemo(() => ({ display: view === 'chat' ? 'links' as const : 'tasks' as const, selectedKey, openTask, report }), [view, selectedKey, openTask, report]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const exportConversation = (format: 'markdown' | 'json') => {
    const payload = format === 'json'
      ? JSON.stringify(entries.map(({ workspaceId, project, message }) => ({ workspaceId, project, ...message })), null, 2)
      : entries.map(({ project, message }) => `## ${project} · ${new Date(message.at).toLocaleString()}\n\n${message.role === 'human' ? '**You**' : '**ApexAgent**'}\n\n${message.text}`).join('\n\n---\n\n');
    const blob = new Blob([payload], { type: format === 'json' ? 'application/json' : 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `apex-agent-conversation.${format === 'json' ? 'json' : 'md'}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const runCommand = (command: Command, lane: string) => {
    if (command.name === 'clear') {
      if (onClear && window.confirm('Hide this conversation on this Mac? Tasks and notifications stay available.')) onClear();
      return;
    }
    if (command.name === 'export') { exportConversation(command.format); return; }
    if (onCommand) { void run(() => Promise.resolve(onCommand(command, lane))); return; }
    setError(`/${command.name} is unavailable in this ApexAgent conversation.`);
  };
  const send = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || sending.current || attachmentState.pending || attachmentState.hasErrors) return;
    const raw = text.trim();
    const parsed = parseComposer(raw);
    if ('command' in parsed) {
      if (parsed.command.name === 'unknown') { setError(`Unknown command: ${parsed.command.typed}`); return; }
      const commandTarget = attachmentLane ?? replyQuotes[0]?.laneId ?? target ?? PERSONAL;
      setText(''); runCommand(parsed.command, commandTarget); return;
    }
    const message = parsed.text.startsWith('//') ? parsed.text.slice(1) : parsed.text;
    const capturedPaths = composerTools.current?.paths() ?? [];
    if ((!message && !capturedPaths.length) || (!selectedTaskContext && !target && !globalReply)) return;
    sending.current = true;
    // Empty the box now so anything typed while waiting survives; a failed send restores the message only into an empty box.
    const capturedTask = replyQuotes.length ? null : selectedTaskContext;
    const capturedQuotes = replyQuotes;
    const sendLane = attachmentLane ?? capturedQuotes[0]?.laneId ?? target;
    const withQuote = capturedQuotes.length ? `${formatApexAgentQuote(capturedQuotes)}${message}` : message;
    const outgoing = composerTools.current?.decorate(withQuote) ?? withQuote;
    setText(''); setDraftFallback(null); setDraftTaskContext(undefined); setFocus(globalReply ? '*' : sendLane);
    void run(async () => {
      try {
        if (capturedTask) await capturedTask.send(outgoing);
        else if (globalReply || sendLane === '*') await onOverview!(outgoing);
        else if (sendLane === PERSONAL) await personal!.send(outgoing);
        else await onReply(sendLane!, outgoing);
        composerTools.current?.clear(capturedPaths);
        if (capturedQuotes.length) setReplyQuotes((current) => current === capturedQuotes ? [] : current);
      } catch (cause) { setText((current) => { if (current.trim()) return current; setDraftTaskContext(capturedTask); return message; }); throw cause; } finally { sending.current = false; }
    });
  };
  const online = monitors.filter((monitor) => !offlineWorkspaceIds.includes(monitor.workspaceId));
  const active = online.filter((monitor) => !monitor.completed);
  const anyPaused = active.some((monitor) => monitor.paused);
  const failed = active.filter((monitor) => monitor.error && !monitor.paused);
  const pausedCount = active.filter((monitor) => monitor.paused).length;
  const watchingCount = active.filter((monitor) => !monitor.paused && !monitor.error && !monitor.activeCheck).length;
  const checkingCount = active.filter((monitor) => !monitor.paused && monitor.activeCheck).length;
  const status = !monitors.length ? 'Not watching any project yet' : [
    watchingCount ? `Watching ${watchingCount} project${watchingCount === 1 ? '' : 's'}` : '',
    checkingCount ? `${checkingCount} checking` : '',
    pausedCount ? `${pausedCount} paused` : '',
    online.filter((monitor) => monitor.completed).length ? `${online.filter((monitor) => monitor.completed).length} complete` : '',
    monitors.length - online.length ? `${monitors.length - online.length} offline` : '',
    failed.length ? `${failed.length} check${failed.length === 1 ? '' : 's'} failed` : '',
    findings.length ? `${findings.length} need${findings.length === 1 ? 's' : ''} you` : '',
  ].filter(Boolean).join(' · ');
  const personalWaiting = (assistant?.tasks ?? []).filter((task) => task.status === 'needsYou' && task.decision?.status === 'open').length;
  const proposedSchedules = (assistant?.schedules ?? []).filter((schedule) => schedule.status === 'proposed' && schedule.decision?.status === 'open');
  const personalStatus = !personal || filterWorkspaceId ? '' : personal.offline ? `${personal.name} on ${personal.hostName} · Offline` : assistant ? `${personal.name} on ${personal.hostName}${assistant.paused ? ' · Paused' : ''}${personalWaiting ? ` · ${personalWaiting} need${personalWaiting === 1 ? 's' : ''} you` : ''}` : '';
  const headline = [monitors.length || !personalStatus ? status : '', personalStatus].filter(Boolean).join(' · ');
  const unseenNotices = filterWorkspaceId ? 0 : (assistant?.notices ?? []).filter((notice) => notice.deliveredAt && !notice.seenAt && notice.deliveredAt > noticesSeenThrough).length;
  // Which machine a task runs on: the assistant's own, or another machine it knows by name.
  const machineOf = (task: PersonalTask) => {
    const host = task.operation?.host;
    if (!assistant || !host || host === assistant.hostId) return personal?.hostName ?? '';
    return assistant.machines?.find((machine) => machine.hostId === host)?.name ?? host;
  };
  const planRows = (plan: NonNullable<PersonalTask['operation']>['plan']) => {
    if (!plan) return null;
    const until = plan.until ? [plan.until.exitCode !== undefined ? `exit code ${plan.until.exitCode}` : '', plan.until.outputContains ? `output contains “${plan.until.outputContains}”` : '', plan.until.outputLacks ? `output lacks “${plan.until.outputLacks}”` : ''].filter(Boolean).join(', ') : '';
    return <>
      {plan.startAt !== undefined && <><dt>Starts</dt><dd>{whenText(plan.startAt)}</dd></>}
      {plan.everyMs !== undefined && <><dt>Repeats</dt><dd>{everyText(plan.everyMs)}{plan.maxRuns !== undefined ? `, up to ${plan.maxRuns} runs` : ''}</dd></>}
      {until && <><dt>Stops when</dt><dd>{until}</dd></>}
      {plan.deadlineAt !== undefined && <><dt>Deadline</dt><dd>{whenText(plan.deadlineAt)}</dd></>}
      {plan.after && <><dt>After</dt><dd>task {plan.after}</dd></>}
    </>;
  };
  const cadenceOf = (schedule: { everyMs?: number; dailyAt?: string }) => schedule.everyMs ? everyText(schedule.everyMs) : schedule.dailyAt ? `Daily at ${schedule.dailyAt}` : 'Scheduled';
  const taskOf = (id?: string): PersonalTask | undefined => assistant?.tasks.find((task) => task.id === id);
  // In the conversation, a task's approval, result and app lines collapse into one link, placed at its first such line.
  const collapsesToLink = (item: PersonalMessage) => !!item.taskId && !!taskOf(item.taskId) && (item.kind === 'approval' || item.kind === 'result' || item.role === 'system');
  const linkLine = new Map<string, string>();
  for (const entry of entries) {
    const item = 'personal' in entry ? entry.personal as PersonalMessage : null;
    if (item && collapsesToLink(item) && !linkLine.has(item.taskId!)) linkLine.set(item.taskId!, item.id);
  }
  const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const plain = (text: string) => text.split('```').filter((_, index) => index % 2 === 0).join(' ').replace(/`/g, '').replace(/\s+/g, ' ').trim();
  // Every personal task as a Tasks row, with its owning host in the key.
  const personalRows: TaskSummary[] = !assistant ? [] : assistant.tasks.map((task) => {
    const results = (assistant.messages ?? []).filter((line) => line.taskId === task.id && line.kind === 'result');
    return {
      key: personalTaskKey(assistant.hostId, task.id), source: 'personal', hostId: assistant.hostId, workspaceId: '', id: task.id,
      title: task.goal, place: machineOf(task), worker: task.kind === 'helper' ? 'Helper' : personal!.name,
      status: task.status, statusLabel: PERSONAL_STATUS[task.status] ?? task.status, group: personalTaskGroup(task),
      result: results.length ? plain(results[results.length - 1].text) : '', updatedAt: task.updatedAt,
    };
  });
  const taskLinkText = (task: PersonalTask) => {
    const asking = task.status === 'needsYou' && task.decision?.status === 'open';
    return asking ? `Task · Needs you · ${task.goal} ›` : task.status === 'done' ? `Result ready · ${task.goal} ›` : `Task · ${PERSONAL_STATUS[task.status] ?? task.status} · ${task.goal} ›`;
  };
  // Detail page lines: every line of the task, whatever the conversation has cleared.
  const linesOf = (task: PersonalTask) => (assistant?.messages ?? []).filter((line) => line.taskId === task.id).sort((a, b) => a.at - b.at);
  const focusedDetail = useRef<string | null>(null);
  if (!selectedKey) focusedDetail.current = null;
  const taskCard = (task: PersonalTask, lines: PersonalMessage[], detail = false) => {
    const asking = task.status === 'needsYou' && task.decision?.status === 'open';
    const expanded = detail || openTasks.includes(task.id);
    const stoppable = task.status === 'queued' || task.status === 'running' || task.status === 'waiting' || task.status === 'blocked';
    const latest = [...lines].reverse().find((line) => line.kind === 'result') ?? lines[lines.length - 1];
    const newest = lines[lines.length - 1];
    const runs = task.runsDone ?? task.receipts.length;
    const plan = task.operation?.plan;
    const until = plan?.until ? [plan.until.exitCode !== undefined ? `exit code ${plan.until.exitCode}` : '', plan.until.outputContains ? `output contains “${plan.until.outputContains}”` : '', plan.until.outputLacks ? `output lacks “${plan.until.outputLacks}”` : ''].filter(Boolean).join(', ') : '';
    const meta = [
      runs ? `Ran ${runs === 1 ? 'once' : runs === 2 ? 'twice' : `${runs} times`}` : '',
      stoppable && task.wait?.kind === 'timer' ? `Next run at ${clock(task.wait.at)}` : '',
      stoppable && task.wait?.kind === 'machine' ? 'Waiting for the Mac to connect' : '',
      stoppable && until ? `Stops when ${until}` : '',
      newest && !asking ? `Updated ${clock(newest.at)}` : '',
    ].filter(Boolean).join(' · ');
    const decision = task.decision;
    const off = busy || personal!.offline;
    const answer = (approve: boolean) => () => void run(() => personal!.decide(decision!.id, decision!.paramsHash, approve));
    const operationRows = task.operation && <dl className="apex-agent-operation">
      <dt>Command</dt><dd><code>{task.operation.argv.join(' ')}</code></dd>
      <dt>Folder</dt><dd><code>{task.operation.cwd}</code></dd>
      <dt>Machine</dt><dd>{machineOf(task)}</dd>
      {planRows(task.operation.plan)}
    </dl>;
    return <article className={`apex-agent-task-card${asking ? ' apex-agent-needs-you' : ''}`} data-status={task.status} key={`task:${task.id}`}>
      <div className="apex-agent-task-card-top"><button type="button" className="apex-agent-project-tag" onClick={() => { setFocus(PERSONAL); setDraftFallback(PERSONAL); }} title={`Reply to ${personal!.name}`}>{machineOf(task)}</button>{task.kind === 'helper' && <span className="apex-agent-helper-label">Helper</span>}<span className="apex-agent-task-chip" data-status={task.status}>{PERSONAL_STATUS[task.status] ?? task.status}</span></div>
      <h3 tabIndex={detail ? -1 : undefined} ref={detail ? (el) => { if (el && focusedDetail.current !== task.id) { focusedDetail.current = task.id; el.focus(); } } : undefined}>{task.goal}</h3>
      {asking ? <p>{decision!.kind === 'handOff' ? 'Your turn: run this yourself, then tell me.' : decision!.kind === 'spend' || decision!.kind === 'uncertain' ? decision!.prompt : 'Approval needed to run this:'}</p> : latest && <p>{plain(latest.text)}</p>}
      {meta && <p className="apex-agent-task-meta">{meta}</p>}
      {asking && operationRows}
      {asking && <div className="apex-agent-buttons apex-agent-task-decide">
        {decision!.kind === 'handOff' ? <>
          <button className="primary" disabled={off} onClick={answer(true)}>I did it</button>
          <button disabled={off} onClick={answer(false)}>Skip</button>
        </> : decision!.kind === 'spend' ? <>
          <button className="primary" disabled={off} onClick={answer(true)}>Go ahead</button>
          <button disabled={off} onClick={answer(false)}>Not now</button>
        </> : <>
          <button className="primary" disabled={off} onClick={answer(true)}>{decision!.kind === 'uncertain' ? 'Run again' : 'Approve'}</button>
          <button disabled={off} onClick={answer(false)}>Decline</button>
        </>}
      </div>}
      <div className="apex-agent-task-card-foot">
        {!detail && <button type="button" className="apex-agent-task-toggle" aria-expanded={expanded} onClick={() => setOpenTasks((ids) => expanded ? ids.filter((id) => id !== task.id) : [...ids, task.id])}>Details &amp; history {expanded ? '▴' : '▾'}</button>}
        {stoppable && <button disabled={off} onClick={() => void run(() => personal!.cancel(task.id))}>Stop task</button>}
      </div>
      {expanded && <div className="apex-agent-task-history">
        {!asking && operationRows}
        <ol>{lines.map((line) => <li key={line.id} className={`apex-agent-history-${line.role}`}><small>{line.role === 'human' ? 'You' : line.role === 'system' ? 'App' : personal!.name} · {clock(line.at)}</small>{fenced(line.text)}</li>)}</ol>
      </div>}
    </article>;
  };
  const batch = async (items: ProjectMonitor[], command: string, args: Record<string, unknown>) => {
    const results = await Promise.allSettled(items.map((monitor) => onMutate(monitor.workspaceId, command, args)));
    const errors = results.flatMap((result, index) => result.status === 'rejected' ? [`${names[items[index].workspaceId]}: ${String(result.reason)}`] : []);
    if (errors.length) throw new Error(errors.join(' · '));
  };
  const unwatched = workspaces.filter((workspace) => !monitors.some((monitor) => monitor.workspaceId === workspace.id));

  const allRows = [...Object.values(reported).flat(), ...personalRows];
  const needsCount = allRows.filter((row) => row.group === 'needsYou').length;
  const projectNeeds = Object.values(reported).flat().filter((row) => row.group === 'needsYou' && (!filterWorkspaceId || row.workspaceId === filterWorkspaceId));
  const visiblePersonalWaiting = filterWorkspaceId ? 0 : personalWaiting;
  const visibleSchedules = filterWorkspaceId ? [] : proposedSchedules;
  const notificationCount = findings.length + failed.filter((monitor) => inView(monitor.workspaceId)).length + projectNeeds.length + visiblePersonalWaiting + visibleSchedules.length + unseenNotices;
  const selectedRow = selectedKey ? allRows.find((row) => row.key === selectedKey) ?? null : null;
  const selectedTask = selectedRow?.source === 'personal' ? assistant?.tasks.find((task) => task.id === selectedRow.id) ?? null : null;
  const closeDetail = () => setSelectedKey(null);
  // Escape closes one layer: a detail goes back to the list, and the list goes back to the conversation.
  const onEscape = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (selectedKey) { event.stopPropagation(); closeDetail(); }
    else if (view !== 'chat') { event.stopPropagation(); switchView('chat'); }
  };
  const tasksHome = () => {
    const places = [...new Set(allRows.map((row) => row.place).filter(Boolean))].sort();
    const current = placeFilter && places.includes(placeFilter) ? placeFilter : null;
    // The place filter only changes what is listed; where a message goes is decided by the composer.
    const shown = current ? allRows.filter((row) => row.place === current) : allRows;
    const groups: [TaskGroup, string][] = [['needsYou', 'Needs you'], ['active', 'Active'], ['finished', 'Finished']];
    return <div className="apex-agent-tasks-home">
      <div className="apex-agent-place-filter" role="group" aria-label="Show tasks for">
        <span className="apex-agent-muted">View</span>
        <button type="button" className="apex-agent-chip-filter" aria-pressed={!current} onClick={() => setPlaceFilter(null)}>All</button>
        {places.map((place) => <button type="button" key={place} className="apex-agent-chip-filter" aria-pressed={current === place} onClick={() => setPlaceFilter(place)}>{place}</button>)}
      </div>
      {!shown.length && <p className="apex-agent-tasks-empty">{current ? `No tasks for ${current}` : 'No tasks yet. Ask ApexAgent to do something and it will show up here.'}</p>}
      {groups.map(([group, heading]) => {
        const rows = shown.filter((row) => row.group === group).sort((a, b) => b.updatedAt - a.updatedAt);
        if (!rows.length) return null;
        return <section key={group} className="apex-agent-task-group" aria-label={heading}>
          <h2>{heading}</h2>
          <ul>{rows.map((row) => <li key={row.key}>
            <button type="button" className="apex-agent-task-row" data-group={row.group} onClick={() => openTask(row.key)}>
              <span className="apex-agent-task-row-top"><span className="apex-agent-task-chip" data-status={row.status}>{row.statusLabel}</span><span className="apex-agent-task-row-when">{whenText(row.updatedAt)}</span></span>
              <strong>{row.title}</strong>
              <small className="apex-agent-task-row-place">{row.place}{row.place && row.worker ? ' · ' : ''}{row.worker}</small>
              {group === 'finished' && row.result && <span className="apex-agent-task-row-result">{row.result}</span>}
              {group === 'finished' && <span className="apex-agent-task-row-tag">{row.status === 'done' ? 'Result ready' : row.statusLabel}</span>}
            </button>
          </li>)}</ul>
        </section>;
      })}
    </div>;
  };
  // The Tasks view below the header: one back bar and one detail, or the list. Project details render inside their own components.
  const tasksSlot = <>
    {selectedKey && <div className="apex-agent-task-bar"><button type="button" className="apex-agent-back" onClick={closeDetail}>‹ Tasks</button>{selectedRow && <span>{selectedRow.title}</span>}</div>}
    {!selectedKey ? tasksHome() : selectedTask ? taskCard(selectedTask, linesOf(selectedTask), true) : !selectedRow && <p className="apex-agent-muted apex-agent-task-missing">This task is no longer available.</p>}
  </>;

  const notificationsSlot = <div className="apex-agent-notifications-home">
    {!!unseenNotices && personal?.seeNotices && <div className="apex-agent-notifications-controls"><span>{unseenNotices} unread personal notice{unseenNotices === 1 ? '' : 's'}</span><button type="button" disabled={busy || personal.offline} onClick={() => { const cutoff = Date.now(); void run(async () => { await personal.seeNotices!(); setNoticesSeenThrough(cutoff); }); }}>Mark all read</button></div>}
    {!notificationCount && <p className="apex-agent-tasks-empty">You’re all caught up.</p>}
    {findings.map(({ workspaceId, finding }) => <article className="assistant-chat-message assistant apex-agent-needs-you" key={`notification-finding:${workspaceId}:${finding.id}`}>
      <small>Needs you{offlineWorkspaceIds.includes(workspaceId) ? ' · Offline, saved evidence' : ''} · {names[workspaceId] ?? 'Project'}</small>
      <p>{finding.summary}</p>
      {finding.reason && <p className="apex-agent-muted">{finding.confidence === 'observed' ? 'Observed' : finding.confidence === 'inferred' ? 'Inferred' : 'Unverified'} · {finding.reason}</p>}
      {evidenceList(finding.evidence ?? [], onOpenEvidence && ((item) => void run(() => onOpenEvidence(workspaceId, item))))}
      <div className="apex-agent-buttons">
        <button disabled={busy || offlineWorkspaceIds.includes(workspaceId)} onClick={() => void run(() => onMutate(workspaceId, 'monitor_resolve', { findingId: finding.id, status: 'resolved' }))}>Resolve</button>
        <button disabled={busy || offlineWorkspaceIds.includes(workspaceId)} onClick={() => void run(() => onMutate(workspaceId, 'monitor_resolve', { findingId: finding.id, status: 'snoozed', snoozedUntil: Date.now() + DAY }))}>Remind me tomorrow</button>
        <button disabled={busy || offlineWorkspaceIds.includes(workspaceId)} onClick={() => void run(() => onMutate(workspaceId, 'monitor_resolve', { findingId: finding.id, status: 'dismissed' }))}>Dismiss</button>
      </div>
    </article>)}
    {failed.filter((monitor) => inView(monitor.workspaceId)).map((monitor) => <article className="assistant-chat-message assistant apex-agent-check-failed" key={`notification-failed:${monitor.workspaceId}`}>
      <small>Last check failed · {names[monitor.workspaceId] ?? 'Project'}</small><p title={monitor.error ?? ''}>{monitor.error}</p>
      <div className="apex-agent-buttons"><button disabled={busy || offlineWorkspaceIds.includes(monitor.workspaceId)} onClick={() => void run(() => onMutate(monitor.workspaceId, 'monitor_check_now', {}))}>Retry</button></div>
    </article>)}
    {projectNeeds.map((row) => <article className="assistant-chat-message assistant apex-agent-needs-you apex-agent-project-task-notice" key={`project-task:${row.key}`}>
      <small>Needs you · {(names[row.workspaceId] ?? row.place) || 'Project'}{row.worker ? ` · ${row.worker}` : ''}</small><p>{row.title}</p>
      <button type="button" className="apex-agent-task-link" data-status="needsYou" onClick={() => openTask(row.key)}>Review in Tasks ›</button>
    </article>)}
    {!filterWorkspaceId && assistant && personal && (assistant.tasks ?? []).filter((task) => task.status === 'needsYou' && task.decision?.status === 'open').map((task) => taskCard(task, linesOf(task)))}
    {!filterWorkspaceId && personal && visibleSchedules.map((schedule) => {
      const decision = schedule.decision!;
      const off = busy || personal.offline;
      return <article className="assistant-chat-message assistant apex-agent-needs-you apex-agent-schedule-card" key={`notification-schedule:${schedule.id}`}>
        <small>{personal.name} · {personal.hostName} · Proposed schedule</small>
        <p>{schedule.goal}</p>
        <dl className="apex-agent-operation"><dt>Command</dt><dd><code>{schedule.argv.join(' ')}</code></dd><dt>Repeats</dt><dd>{cadenceOf(schedule)}</dd></dl>
        <div className="apex-agent-buttons">
          <button className="primary" disabled={off} onClick={() => void run(() => personal.decide(decision.id, decision.paramsHash, true))}>Confirm schedule</button>
          <button disabled={off} onClick={() => void run(() => personal.decide(decision.id, decision.paramsHash, false))}>Decline</button>
        </div>
      </article>;
    })}
    {!filterWorkspaceId && (assistant?.notices ?? []).filter((notice) => !!notice.deliveredAt).sort((a, b) => b.at - a.at).map((notice) => {
      const seen = !!notice.seenAt || notice.deliveredAt! <= noticesSeenThrough;
      const task = taskOf(notice.taskId);
      return <article className={`assistant-chat-message assistant apex-agent-personal-notice${seen ? ' is-seen' : ' is-unseen'}`} key={`notice:${notice.id}`}>
        <small>{personal?.name ?? 'Assistant'} · {whenText(notice.at)}{notice.urgent ? ' · Urgent' : ''}</small>
        <p>{notice.text}</p>
        {task && <button type="button" className="apex-agent-task-link" data-status={task.status} onClick={() => openTask(personalTaskKey(assistant!.hostId, task.id))}>{taskLinkText(task)}</button>}
      </article>;
    })}
  </div>;
  const restoreMessage = (lane: string, value: string) => {
    if (attachmentLane && attachmentLane !== lane) {
      setError('Remove the current attachments before reverting a message from another destination.');
      return;
    }
    if (text.trim() && text !== value && !window.confirm('Replace the current draft with this message?')) return;
    setError('');
    setText(value); setReplyQuotes([]); setDraftTaskContext(null); onClearTaskContext?.(); setFocus(lane); setDraftFallback(lane);
    requestAnimationFrame(() => composerInput.current?.focus());
  };
  const composerLane = attachmentLane ?? replyQuotes[0]?.laneId ?? target ?? PERSONAL;

  return <TaskViewContext.Provider value={taskContextValue}><section className="apex-agent widget apex-agent-all" role="region" aria-label="ApexAgent" onKeyDown={onEscape}>
    <header className="apex-agent-head">
      <div className="apex-agent-head-row">
        <div className="apex-agent-brand"><h1>ApexAgent</h1></div>
        <div className="apex-agent-head-actions">{assistant && personal && <button className="icon" aria-label="Voice call" title="Voice call" onClick={() => setCalling(true)}>📞</button>}<details className="apex-agent-more"><summary aria-label="More ApexAgent options">⋯</summary><div role="menu">
          {!!monitors.length && <button type="button" role="menuitem" disabled={busy} onClick={() => void run(async () => { await batch(active.filter((monitor) => monitor.paused === anyPaused), 'monitor_pause', { paused: !anyPaused }); })}>{anyPaused ? 'Resume project watching' : 'Pause project watching'}{anyPaused && <small>Start checking your project folders again.</small>}</button>}
          {!!monitors.length && <button type="button" role="menuitem" disabled={busy || !active.some((monitor) => !monitor.paused)} onClick={() => void run(async () => { await batch(active.filter((monitor) => !monitor.paused), 'monitor_check_now', {}); })}>Check now</button>}
          {onClear && !!entries.length && <button type="button" role="menuitem" onClick={() => { if (window.confirm('Hide this conversation on this Mac? Tasks and notifications stay available.')) onClear(); }}>Clear conversation</button>}
          {assistant && (['activity', 'scheduled', 'memory', 'rules', 'settings', 'costs', 'connections'] as const).map((name) => <button type="button" role="menuitem" key={name} onClick={(event) => openPanel(name, event)}>{{ activity: 'Activity', scheduled: 'Scheduled', memory: 'Memory', rules: 'Rules', settings: 'Assistant settings', costs: 'Costs', connections: 'Connections' }[name]}</button>)}
          {assistant && personal?.pause && <button type="button" role="menuitem" disabled={busy || personal.offline} onClick={() => void run(() => personal.pause!(!assistant.paused))}>{assistant.paused ? 'Resume assistant' : 'Pause assistant'}</button>}
          {personal?.setUp && <button type="button" role="menuitem" disabled={busy || personal.offline} onClick={() => void run(personal.setUp!)}>Set up assistant on {personal.hostName}</button>}
          {onCustomize && <button type="button" role="menuitem" onClick={onCustomize}>Quiet hours</button>}
          {onHide && <button type="button" role="menuitem" onClick={onHide}>Hide</button>}
          {workspaces.map((workspace) => <button type="button" role="menuitem" key={workspace.id} onClick={() => onSetUp(workspace.id)}>{monitors.some((monitor) => monitor.workspaceId === workspace.id) ? `Sources · ${workspace.name}` : `Watch ${workspace.name}…`}</button>)}
        </div></details>{onFullScreen && <button className="icon" onClick={onFullScreen} aria-pressed={fullScreen} aria-label={fullScreen ? 'Exit full screen' : 'Full screen'} title={fullScreen ? 'Exit full screen' : 'Full screen'}>{fullScreen ? '⤡' : '⤢'}</button>}<button className="icon" onClick={onClose} aria-label="Close ApexAgent">×</button></div>
      </div>
      <div className="apex-agent-head-row apex-agent-head-context"><p>{headline}</p></div>
      <div className="apex-agent-head-row apex-agent-views" role="tablist" aria-label="ApexAgent views">
        <button type="button" role="tab" className="apex-agent-view-tab" aria-selected={view === 'chat'} onClick={() => switchView('chat')}>Chat</button>
        <button type="button" role="tab" className="apex-agent-view-tab" aria-selected={view === 'tasks'} onClick={() => switchView('tasks')}>Tasks{needsCount > 0 && <b className="apex-agent-tabs-count">{` · ${needsCount}`}</b>}</button>
        <button type="button" role="tab" className="apex-agent-view-tab" aria-selected={view === 'notifications'} onClick={() => switchView('notifications')}>Notifications{notificationCount > 0 && <b className="apex-agent-tabs-count">{` · ${notificationCount}`}</b>}</button>
      </div>
    </header>
    {filterWorkspaceId && <div className="apex-agent-filter-bar" role="status"><span>Showing {filterName} only</span><button type="button" onClick={() => onClearFilter?.()}>Show all</button></div>}
    {error && <div className="apex-agent-error" role="alert">{error}</div>}
    <div className="apex-agent-tabpanel" ref={scroller}><div className="assistant-chat-transcript" aria-live="polite">
      {view === 'chat' ? <>
      {entries.map(({ workspaceId, project, message, ...entry }) => {
        const item = 'personal' in entry ? entry.personal as PersonalMessage : null;
        if (item) {
          const task = taskOf(item.taskId);
          if (task && collapsesToLink(item)) return linkLine.get(task.id) === item.id ? <p className="apex-agent-task-line" key={`${workspaceId}:${message.id}`}><button type="button" className="apex-agent-task-link" data-status={task.status} onClick={() => openTask(personalTaskKey(assistant!.hostId, task.id))}>{taskLinkText(task)}</button></p> : null;
          const kindClass = item.kind === 'helper' ? ' apex-agent-helper' : item.kind === 'notice' ? ' apex-agent-notice' : '';
          const personalBubble = `assistant-chat-message ${message.role} apex-agent-personal${item.role === 'system' ? ' apex-agent-app-note' : ''}${kindClass}`;
          const personalBody = <>
            <small className="apex-agent-message-meta">{item.role === 'human' ? 'You' : item.role === 'system' ? 'App' : personal!.name}{lanes.length > 1 && <> · <button type="button" className="apex-agent-project-tag" onClick={() => { setFocus(PERSONAL); setDraftFallback(PERSONAL); }} title={`Reply to ${personal!.name}`}>{personal!.hostName}</button></>}{item.kind === 'helper' && <span className="apex-agent-helper-label">Helper</span>}</small>
            {item.role === 'human' ? <p>{message.text}</p> : <div className="apex-agent-message-body"><Markdown text={message.text} onOpen={openMessageLink} /></div>}
          </>;
          const personalActions = (item.role === 'human' || item.role === 'assistant') ? <ApexAgentMessageActions mine={item.role === 'human'} text={item.text} at={item.at} stateKey={messageStateKey(assistant!.hostId, PERSONAL, item.id)} onRetry={item.role === 'assistant' ? () => personal!.send(retryMessageText(item.text)) : undefined} onRevert={item.role === 'human' ? () => restoreMessage(PERSONAL, item.text) : undefined} reactions={item.reactions} disabled={busy || !!personal?.offline} onReply={!attachmentLane || attachmentLane === PERSONAL ? () => {
            addReplyQuote({ messageId: item.id, author: item.role === 'human' ? 'You' : personal!.name, text: item.text, laneId: PERSONAL });
          } : undefined} onToggleReaction={onReact ? (emoji, enabled) => run(() => onReact(PERSONAL, item.id, emoji, enabled)) : undefined} /> : null;
          return personalActions
            ? <article className={`apex-agent-message-row ${message.role}`} key={`${workspaceId}:${message.id}`}><div className={personalBubble}>{personalBody}</div>{personalActions}</article>
            : <article className={personalBubble} key={`${workspaceId}:${message.id}`}>{personalBody}</article>;
        }
        const projectBubble = `assistant-chat-message ${message.role}`;
        const projectBody = <>
          <small className="apex-agent-message-meta">{message.role === 'human' ? 'You' : 'ApexAgent'} · <button type="button" className="apex-agent-project-tag" onClick={() => { setFocus(workspaceId); setDraftFallback(workspaceId); }} title={`Reply about ${project}`}>{project}</button>{'kind' in message && message.kind === 'update' && <span className="apex-agent-helper-label">Project update</span>}</small>
          {message.role === 'human' ? <p>{message.text}</p> : <div className="apex-agent-message-body"><Markdown text={message.text} onOpen={openMessageLink} /></div>}
          {'citations' in entry && (entry.citations as { workspaceId: string; evidence: MonitorEvidence }[] | undefined)?.map((cite, index) => <div key={index}>{evidenceList([cite.evidence], onOpenEvidence && ((item) => void run(() => onOpenEvidence(cite.workspaceId, item))))}</div>)}
          {evidenceList(message.evidence ?? [], onOpenEvidence && ((item) => void run(() => onOpenEvidence(workspaceId, item))))}
        </>;
        const projectActions = (message.role === 'human' || message.role === 'assistant') ? <ApexAgentMessageActions mine={message.role === 'human'} text={message.text} at={message.at} stateKey={messageStateKey(workspaces.find((w) => w.id === workspaceId)?.hostId ?? '', workspaceId, message.id)} onRetry={message.role === 'assistant' ? () => workspaceId === '*' ? onOverview!(retryMessageText(message.text)) : onReply(workspaceId, retryMessageText(message.text)) : undefined} onRevert={message.role === 'human' ? () => restoreMessage(workspaceId, message.text) : undefined} reactions={message.reactions} disabled={busy || offlineWorkspaceIds.includes(workspaceId)} onReply={!attachmentLane || attachmentLane === workspaceId ? () => {
          addReplyQuote({ messageId: message.id, author: message.role === 'human' ? 'You' : project, text: message.text, laneId: workspaceId });
        } : undefined} onToggleReaction={onReact && monitors.some((monitor) => monitor.workspaceId === workspaceId) ? (emoji, enabled) => run(() => onReact(workspaceId, message.id, emoji, enabled)) : undefined} /> : null;
        return projectActions
          ? <article className={`apex-agent-message-row ${message.role}`} key={`${workspaceId}:${message.id}`}><div className={projectBubble}>{projectBody}</div>{projectActions}</article>
          : <article className={projectBubble} key={`${workspaceId}:${message.id}`}>{projectBody}</article>;
      })}
      {!filterWorkspaceId && personal?.problem && <article className="assistant-chat-message assistant"><small>{personal.name} · {personal.hostName}</small><p>{personal.problem}</p></article>}
      {!filterWorkspaceId && personal?.setUp && !monitors.length && <div className="apex-agent-intro"><strong>Your assistant can live on {personal.hostName}.</strong><p>It keeps one conversation that stays there when this Mac is closed. Choose “Set up assistant on {personal.hostName}” from ⋯.</p></div>}
      {!monitors.length && !assistant && !personal?.setUp && <div className="apex-agent-intro"><strong>Hi, I’m ApexAgent.</strong><p>I keep up with all your projects in one conversation. Pick a project to watch from ⋯ and tell me what to keep on track.</p></div>}
      {!!monitors.length && !!unwatched.length && entries.length === 0 && <p className="apex-agent-muted">Not watching yet: {unwatched.map((workspace) => workspace.name).join(', ')}.</p>}
      </> : view === 'tasks' ? tasksSlot : notificationsSlot}
      {shownTasks}
      <div ref={bottom} />
    </div></div>
    {/* Over the whole popup, not inside the scrolling transcript. */}
    {panelOpen && personal && <div className="apex-agent-panels-sheet">
      <PersonalPanels key={panelOpen} lane={personal} initial={panelOpen} onClose={() => setPanelOpen(null)} />
    </div>}
    {(!!watched.length || !!selectedTaskContext || !!assistant) && <form className="apex-agent-all-composer" onSubmit={send} hidden={view !== 'chat'}>
      {selectedTaskContext && <div className="assistant-composer-heading"><strong>{selectedTaskContext.project} · {selectedTaskContext.label}</strong><button type="button" onClick={() => { setDraftTaskContext(null); setFocus(null); setDraftFallback(null); onClearTaskContext?.(); }}>New message</button></div>}
      <ApexAgentReplyQuote quotes={replyQuotes} onClear={() => setReplyQuotes([])} onRemove={(index) => setReplyQuotes((list) => list.filter((_, i) => i !== index))} />
      <div className="apex-agent-all-compose-box">
        <ApexAgentComposerTools ref={composerTools} value={text} disabled={busy} onChange={(value) => { setText(value); setCaret(composerInput.current?.selectionStart ?? value.length); }} inputRef={composerInput} menuRef={composerMenu} participants={lanes.map((lane) => ({ id: lane.id, display_name: lane.name, mention: laneHandles.get(lane.id) }))} servers={serversByLane[composerLane] ?? []} serverStatus={serverStatusByLane[composerLane]} includeAll={!!onOverview && !filterWorkspaceId} allMentionDetail="Ask across projects" onTools={composerLane === PERSONAL && assistant ? () => setPanelOpen('connections') : undefined} folderUnavailableReason={pickFolderUnavailableReason} filesUnavailableReason={!saveAttachment ? 'File attachments are unavailable on this destination.' : undefined} trigger={findTrigger(text, caret)}
          saveAttachment={saveAttachment && !selectedTaskContext ? (name, bytes) => {
            if (busy || sending.current) throw new Error('Wait until the current message finishes before adding attachments.');
            const lane = attachmentLane ?? replyQuotes[0]?.laneId ?? target ?? PERSONAL;
            setAttachmentLane((current) => current ?? lane);
            return saveAttachment(lane, name, bytes);
          } : undefined}
          pickFolder={pickAttachmentFolder && !selectedTaskContext && !busy ? () => pickAttachmentFolder(composerLane) : undefined}
          onChooseAttachment={() => { if (!selectedTaskContext) setAttachmentLane((current) => current ?? composerLane); }}
          onChooseFolder={() => { if (!selectedTaskContext) setAttachmentLane((current) => current ?? composerLane); }}
          onAttachmentState={(next) => { setAttachmentState(next); if (next.paths.length || next.pending || next.hasErrors) setAttachmentLane((current) => current ?? composerLane); else setAttachmentLane(null); }}
          disabledCommands={{
            ...(!onClear ? { clear: 'Clear is unavailable here.' } : {}),
            ...(!onCommand ? {
              compact: 'The ApexAgent host does not expose conversation compaction.',
              fork: 'ApexAgent does not expose thread forking.',
              diff: 'Choose a project change action from its project controls.',
              plan: 'ApexAgent does not expose a host planning switch.',
              image: 'Image generation is not connected to this conversation.',
            } : {}),
          }}
          onCommand={(command) => runCommand(command, attachmentLane ?? replyQuotes[0]?.laneId ?? target ?? PERSONAL)} />
        <textarea ref={composerInput} className="apex-agent-all-input" value={text} onChange={(event) => { const value = event.target.value; if (!value.trim()) { setDraftFallback(null); setDraftTaskContext(undefined); } else if (!text.trim()) { setDraftFallback(filterWorkspaceId ?? focus ?? lastSpoken ?? (assistant ? PERSONAL : onOverview ? '*' : null)); setDraftTaskContext(selectedTaskContext); } setText(value); setCaret(event.currentTarget?.selectionStart ?? value.length); }} onClick={(event) => setCaret(event.currentTarget?.selectionStart ?? text.length)} onKeyUp={(event) => setCaret(event.currentTarget?.selectionStart ?? text.length)} rows={1} aria-label="Message ApexAgent" placeholder={selectedTaskContext ? 'Reply to this task…' : (attachmentLane ?? replyQuotes[0]?.laneId ?? target) === PERSONAL ? `Message ${personal!.name}…` : 'Ask about any project…'}
          onKeyDown={(event) => { if (composerMenu.current?.key(event)) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      </div>
      <div className="apex-agent-all-compose-row"><small className="apex-agent-muted apex-agent-all-destination">{selectedTaskContext ? `Reply to ${selectedTaskContext.project} · ${selectedTaskContext.label}` : globalReply ? 'About all projects' : (attachmentLane ?? replyQuotes[0]?.laneId ?? target) === PERSONAL ? `To ${personalTag}` : attachmentLane || replyQuotes.length ? `About ${laneNames[attachmentLane ?? replyQuotes[0]!.laneId] ?? 'Project'} · fixed for this reply` : target ? `About ${laneNames[target]}` : ''}{!selectedTaskContext && lanes.length > 1 && !replyQuotes.length && !attachmentLane ? ' · name a project to switch' : ''}{attachmentState.paths.length ? ` · ${attachmentState.paths.length} attachment${attachmentState.paths.length === 1 ? '' : 's'}` : ''}</small><button className="primary apex-agent-all-send" disabled={busy || (!text.trim() && !attachmentState.paths.length) || attachmentState.pending || attachmentState.hasErrors || (!selectedTaskContext && !target && !globalReply)}>{busy ? 'Sending…' : 'Send'}</button></div>
    </form>}
    {calling && personal && <PersonalCall lane={personal} onEnd={() => setCalling(false)} />}
    {busy && <div className="apex-agent-busy" role="status">Saving…</div>}
  </section></TaskViewContext.Provider>;
}
