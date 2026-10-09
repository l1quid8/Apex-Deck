import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent, type ReactNode } from 'react';
import type { Workspace } from './types.ts';
import type { ProjectMonitor } from './apexAgentModel.ts';
import { ASSISTANT_SOURCE_MIME, activeMonitorFindings, aggregateFindingCount, assistantSourceOwnerKey, firstActiveFinding, isQuietHours, parseAssistantSourceDrop, sameWidgetPosition, shouldShowFindingBubble, widgetCoordinates, widgetSidePanelPosition, widgetStatus, widgetStatusLabel, checkFailureReason, type AssistantSourceDrop, type WidgetPosition } from './apexAgentWidgetModel.ts';
import './apex-agent-widget.css';

export type { AssistantSourceDrop } from './apexAgentWidgetModel.ts';
export { ASSISTANT_SOURCE_MIME } from './apexAgentWidgetModel.ts';

type Look = { name: string; color: 'mint' | 'cyan' | 'violet' | 'amber'; shape: 'orb' | 'bot' | 'blob' };
const POS_KEY = 'apex-agent-widget-position-v2';
const LOOK_KEY = 'apex-agent-widget-look-v2';
const QUIET_KEY = 'apex-agent-widget-quiet-hours-v1';
const colors: Look['color'][] = ['mint', 'cyan', 'violet', 'amber'];
const shapes: Look['shape'][] = ['orb', 'bot', 'blob'];
const defaultLook: Look = { name: 'Apex', color: 'mint', shape: 'orb' };
type QuietHours = { enabled: boolean; start: string; end: string };
const defaultQuietHours: QuietHours = { enabled: false, start: '22:00', end: '08:00' };
const validClockTime = (value: unknown): value is string => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

function readStored<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? { ...(fallback as object), ...JSON.parse(value) } as T : fallback; } catch { return fallback; }
}
function saveStored(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage can be disabled */ } }
function monitorFor(monitors: ProjectMonitor[], id: string | null) { return monitors.find((monitor) => monitor.workspaceId === id); }

export function ApexAgentWidget({ workspaces, workspaceId, open, monitors, onOpen, onClose, onSelect, onAddSource, children, offlineWorkspaceIds = [], onReply, onRetry, appearanceRequest = 0, hideRequest = 0 }: {
  workspaces: Workspace[];
  workspaceId: string | null;
  open: boolean;
  monitors: ProjectMonitor[];
  onOpen: (workspaceId: string) => void;
  onClose: () => void;
  onSelect: (workspaceId: string) => void;
  onAddSource: (payload: AssistantSourceDrop) => Promise<void>;
  children?: ReactNode;
  offlineWorkspaceIds?: string[];
  onReply?: (workspaceId: string, text: string) => Promise<void>;
  onRetry?: (workspaceId: string) => Promise<void>;
  appearanceRequest?: number;
  hideRequest?: number;
}) {
  const [retry, setRetry] = useState<{ workspaceId: string; state: 'sending' | 'failed'; message?: string } | null>(null);
  const [position, setPosition] = useState<WidgetPosition>(() => {
    const saved = readStored<Partial<WidgetPosition>>(POS_KEY, {});
    return { edge: saved.edge === 'left' ? 'left' : 'right', y: Number.isFinite(saved.y) ? saved.y! : 240 };
  });
  const positionRef = useRef(position);
  const [look, setLook] = useState<Look>(() => {
    const saved = readStored<Partial<Look>>(LOOK_KEY, {});
    return { name: typeof saved.name === 'string' ? saved.name.slice(0, 20) || 'Apex' : 'Apex', color: colors.includes(saved.color as Look['color']) ? saved.color! : defaultLook.color, shape: shapes.includes(saved.shape as Look['shape']) ? saved.shape! : defaultLook.shape };
  });
  const [quietHours, setQuietHours] = useState<QuietHours>(() => {
    const saved = readStored<Partial<QuietHours>>(QUIET_KEY, {});
    return { enabled: saved.enabled === true, start: validClockTime(saved.start) ? saved.start : defaultQuietHours.start, end: validClockTime(saved.end) ? saved.end : defaultQuietHours.end };
  });
  const [clock, setClock] = useState(() => Date.now());
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [dropStates, setDropStates] = useState<Record<string, { id: string; state: 'adding' | 'added' | 'error'; message?: string }>>({});
  const [bubbleHidden, setBubbleHidden] = useState<Set<string>>(() => new Set());
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyBusy, setReplyBusy] = useState<string | null>(null);
  const [replyErrors, setReplyErrors] = useState<Record<string, string>>({});
  const [tipVisible, setTipVisible] = useState(false);
  const [panelHeight, setPanelHeight] = useState(640);
  const [bubbleHeight, setBubbleHeight] = useState(220);
  const [dropHeight, setDropHeight] = useState(48);
  const avatarRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const previousAppearanceRequest = useRef(appearanceRequest);
  const previousHideRequest = useRef(hideRequest);
  const previousOpen = useRef(open);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null);
  const dragClickRef = useRef(false);
  const selected = workspaces.find((workspace) => workspace.id === workspaceId);
  const selectedMonitor = monitorFor(monitors, workspaceId);
  const findings = useMemo(() => aggregateFindingCount(monitors, new Set(workspaces.map((workspace) => workspace.id))), [monitors, workspaces, clock]);
  const activeBubble = useMemo(() => firstActiveFinding(monitors, workspaces), [monitors, workspaces, clock]);
  const activeBubbleWorkspace = activeBubble && workspaces.find((workspace) => workspace.id === activeBubble.monitor.workspaceId);
  const bubbleKey = activeBubble ? `${activeBubble.monitor.workspaceId}:${activeBubble.finding.id}` : '';
  const quietActive = isQuietHours(quietHours.enabled, quietHours.start, quietHours.end, new Date(clock));
  const showBubble = shouldShowFindingBubble(!!activeBubble, bubbleHidden.has(bubbleKey), quietActive, open);
  const selectedDropOwner = selected ? assistantSourceOwnerKey(selected) : '';
  const selectedDropState = selectedDropOwner ? dropStates[selectedDropOwner] : undefined;
  const replyText = replyDrafts[bubbleKey] ?? '';
  const status = widgetStatus(selected, selectedMonitor, offlineWorkspaceIds);
  const coords = typeof window === 'undefined' ? { left: 16, top: position.y } : widgetCoordinates(position, { width: window.innerWidth, height: window.innerHeight });
  const wrapStyle = { left: coords.left, top: coords.top, '--aa-color': `var(--apex-widget-${look.color})` } as CSSProperties;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const panelTop = Math.max(12, Math.min(coords.top, viewportHeight - Math.min(panelHeight, viewportHeight - 32) - 12));
  const bubbleTop = Math.max(12, Math.min(coords.top + 54, viewportHeight - Math.min(bubbleHeight, viewportHeight - 32) - 12));
  const dropTop = Math.max(12, Math.min(coords.top, viewportHeight - Math.min(dropHeight, viewportHeight - 32) - 12));
  const panelWidth = Math.min(420, viewportWidth - 104);
  const panelHorizontal = widgetSidePanelPosition(position.edge, coords.left, viewportWidth, panelWidth, 56, 12, 12);
  const panelStyle = { ...panelHorizontal, top: panelTop };
  const bubbleStyle = position.edge === 'left' ? { left: 84, top: bubbleTop } : { right: 84, top: bubbleTop };
  const contextWidth = Math.min(editing ? 250 : 212, viewportWidth - 32);
  const contextTop = Math.max(16, Math.min(coords.top, viewportHeight - (editing ? 270 : 180) - 16));
  const contextHorizontal = widgetSidePanelPosition(position.edge, coords.left, viewportWidth, contextWidth, 56, 10, 16);
  const contextStyle = { ...contextHorizontal, width: contextWidth, top: contextTop };

  const positionAvatar = useCallback((next: WidgetPosition) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const clamped = widgetCoordinates(next, viewport);
    const browser = document.querySelector<HTMLElement>('.browser-place');
    let edge = next.edge;
    let y = clamped.top;
    if (browser) {
      const rect = browser.getBoundingClientRect();
      const overlap = (x: number) => x < rect.right && x + 56 > rect.left && y < rect.bottom && y + 56 > rect.top;
      const preferredX = edge === 'left' ? 16 : Math.max(16, viewport.width - 72);
      if (overlap(preferredX)) {
        const opposite: WidgetPosition = { edge: edge === 'left' ? 'right' : 'left', y };
        const oppositeXY = widgetCoordinates(opposite, viewport);
        if (!overlap(oppositeXY.left)) edge = opposite.edge;
        else if (rect.bottom + 72 <= viewport.height - 16) y = rect.bottom + 16;
        else if (rect.top - 72 >= 16) y = rect.top - 72;
      }
    }
    const fixed = { edge, y } as WidgetPosition;
    const previous = positionRef.current;
    if (sameWidgetPosition(previous, fixed)) return;
    positionRef.current = fixed;
    setPosition(fixed);
    saveStored(POS_KEY, fixed);
  }, []);

  useEffect(() => {
    const reposition = () => positionAvatar(position);
    window.addEventListener('resize', reposition);
    const observer = new MutationObserver(reposition);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    reposition();
    return () => { window.removeEventListener('resize', reposition); observer.disconnect(); };
  }, [position, positionAvatar]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (editing || menu) {
        event.preventDefault(); event.stopImmediatePropagation();
        setEditing(false); setMenu(false); requestAnimationFrame(() => avatarRef.current?.focus());
      } else if (open) {
        event.preventDefault(); event.stopImmediatePropagation();
        onClose(); requestAnimationFrame(() => avatarRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, editing, menu]);

  useEffect(() => { saveStored(LOOK_KEY, look); }, [look]);
  useEffect(() => { saveStored(QUIET_KEY, quietHours); }, [quietHours]);
  useEffect(() => { if (open && !previousOpen.current) setHidden(false); previousOpen.current = open; }, [open]);
  useEffect(() => {
    if (appearanceRequest !== previousAppearanceRequest.current && appearanceRequest > 0) { setHidden(false); setMenu(false); setEditing(true); }
    previousAppearanceRequest.current = appearanceRequest;
  }, [appearanceRequest]);
  useEffect(() => {
    if (hideRequest !== previousHideRequest.current && hideRequest > 0) { setMenu(false); setEditing(false); setHidden(true); if (open) onClose(); }
    previousHideRequest.current = hideRequest;
  }, [hideRequest, open, onClose]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { const next = element.getBoundingClientRect().height; setPanelHeight((previous) => Math.abs(previous - next) < 1 ? previous : next); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, children, workspaceId]);
  useEffect(() => {
    const element = bubbleRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { const next = element.getBoundingClientRect().height; setBubbleHeight((previous) => Math.abs(previous - next) < 1 ? previous : next); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [showBubble, bubbleKey, onReply]);
  useEffect(() => {
    const element = dropRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { const next = element.getBoundingClientRect().height; setDropHeight((previous) => Math.abs(previous - next) < 1 ? previous : next); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [selectedDropState?.id, selectedDropState?.state, selectedDropState?.message]);

  const activate = () => {
    if (dragClickRef.current) { dragClickRef.current = false; return; }
    if (open) { onClose(); return; }
    if (selected) onOpen(selected.id);
  };
  const closePanel = () => { onClose(); requestAnimationFrame(() => avatarRef.current?.focus()); };
  const move = (edge: 'left' | 'right', y = position.y) => positionAvatar({ edge, y });
  const pointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
    if (!drag.moved) return;
    const edge = event.clientX < window.innerWidth / 2 ? 'left' : 'right';
    positionAvatar({ edge, y: event.clientY - 28 });
  };
  const pointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragClickRef.current = drag.moved;
    dragRef.current = null;
  };
  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDropActive(false);
    const destination = workspaces.find((workspace) => workspace.id === workspaceId);
    const raw = event.dataTransfer.getData(ASSISTANT_SOURCE_MIME) || event.dataTransfer.getData('text/plain');
    if (!destination) return;
    const capturedId = destination.id;
    const capturedOwner = assistantSourceOwnerKey(destination);
    const payload = parseAssistantSourceDrop(raw, destination, monitorFor(monitors, capturedId));
    if (!payload) { setDropStates((previous) => ({ ...previous, [capturedOwner]: { id: String(Date.now()), state: 'error', message: 'That source is already watched or does not match this project.' } })); return; }
    const id = `${capturedOwner}:${payload.kind}:${payload.sourceId}`;
    setDropStates((previous) => ({ ...previous, [capturedOwner]: { id, state: 'adding' } }));
    try {
      await onAddSource(payload);
      setDropStates((previous) => previous[capturedOwner]?.id === id ? { ...previous, [capturedOwner]: { id, state: 'added' } } : previous);
      window.setTimeout(() => setDropStates((previous) => {
        if (previous[capturedOwner]?.id !== id || previous[capturedOwner]?.state !== 'added') return previous;
        const next = { ...previous }; delete next[capturedOwner]; return next;
      }), 4_000);
    }
    catch (error) { setDropStates((previous) => previous[capturedOwner]?.id === id ? { ...previous, [capturedOwner]: { id, state: 'error', message: error instanceof Error ? error.message : 'Could not add source.' } } : previous); }
  };
  const chooseProject = (id: string) => { onSelect(id); };
  const setLookValue = (patch: Partial<Look>) => setLook((current) => ({ ...current, ...patch }));
  const sendReply = async () => {
    const text = replyText.trim();
    if (!activeBubble || !text || !onReply || replyBusy) return;
    const ownerId = activeBubble.monitor.workspaceId;
    const ownerKey = bubbleKey;
    setReplyBusy(ownerKey);
    setReplyErrors((previous) => { const next = { ...previous }; delete next[ownerKey]; return next; });
    try { await onReply(ownerId, text); setReplyDrafts((previous) => ({ ...previous, [ownerKey]: '' })); }
    catch (error) { setReplyErrors((previous) => ({ ...previous, [ownerKey]: error instanceof Error ? error.message : 'Could not send reply.' })); }
    finally { setReplyBusy((current) => current === ownerKey ? null : current); }
  };

  return <div className={`apex-widget-root ${hidden ? 'is-hidden' : ''}`}>
    <div className={`apex-widget-avatar edge-${position.edge} apex-widget-${look.shape} apex-color-${look.color} status-${status} ${findings > 0 ? 'tone-needs-you' : ''} ${open ? 'is-open' : ''} ${dropActive ? 'is-drop' : ''}`} style={wrapStyle} data-apex-agent-overlay="avatar" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }} onDrop={(event) => void onDrop(event)}>
      <button ref={avatarRef} type="button" className="apex-widget-hit" aria-label={`${look.name}, ${widgetStatusLabel(status)}${findings ? `, ${findings} active findings` : ''}`} aria-haspopup="dialog" aria-expanded={open} onMouseEnter={() => setTipVisible(true)} onMouseLeave={() => setTipVisible(false)} onFocus={() => setTipVisible(true)} onBlur={() => setTipVisible(false)} onClick={activate} onContextMenu={(event) => { event.preventDefault(); setMenu((value) => !value); }} onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? 'left' : 'right'); }
        else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); positionAvatar({ edge: position.edge, y: position.y + (event.key === 'ArrowUp' ? -24 : 24) }); }
      }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
        <span className="apex-widget-halo" /><span className="apex-widget-core"><i /><i /></span><span className="apex-widget-open-ring" />
        {findings > 0 && <span className="apex-widget-count">{findings}</span>}
        {status === 'paused' && <span className="apex-widget-paused" aria-hidden="true">Ⅱ</span>}{status === 'offline' && <span className="apex-widget-offline" aria-hidden="true" />}{status === 'failed' && <span className="apex-widget-failed-mark" aria-hidden="true">!</span>}
        {tipVisible && !open && !editing && !menu && <span className="apex-widget-tip" data-apex-agent-overlay="tooltip">{look.name} · {widgetStatusLabel(status)}{findings ? ` · ${findings} need you` : ''}</span>}
        {dropActive && <span className="apex-widget-drop-tip">Add source to {selected?.name ?? 'project'}</span>}
      </button>
      {menu && <div className="apex-widget-menu" style={contextStyle} role="menu" data-apex-agent-overlay="menu">
        <button role="menuitem" onClick={() => { setMenu(false); setEditing(true); }}>Make it yours…</button>
        <button role="menuitem" onClick={() => { setMenu(false); setHidden((value) => !value); }}>{hidden ? 'Show avatar' : 'Hide avatar'}</button>
        <button role="menuitem" onClick={() => { setMenu(false); positionAvatar({ edge: 'right', y: Math.min(240, window.innerHeight - 72) }); }}>Reset position</button>
        <button role="menuitem" onClick={() => setMenu(false)}>Close menu</button>
      </div>}
      {editing && <div className="apex-widget-editor" style={contextStyle} role="dialog" aria-label="Make Apex yours" data-apex-agent-overlay="editor">
        <button className="apex-widget-editor-close" onClick={() => setEditing(false)} aria-label="Close appearance editor">×</button>
        <label>Name <input value={look.name} maxLength={20} onChange={(event) => setLookValue({ name: event.target.value || 'Apex' })} /></label>
        <label>Color <select value={look.color} onChange={(event) => setLookValue({ color: event.target.value as Look['color'] })}>{colors.map((color) => <option key={color}>{color}</option>)}</select></label>
        <label>Shape <select value={look.shape} onChange={(event) => setLookValue({ shape: event.target.value as Look['shape'] })}>{shapes.map((shape) => <option key={shape}>{shape}</option>)}</select></label>
        <div className="apex-widget-quiet-settings"><strong>Quiet hours</strong><button type="button" className={quietHours.enabled ? 'enabled' : ''} aria-pressed={quietHours.enabled} onClick={() => setQuietHours((current) => ({ ...current, enabled: !current.enabled }))}>{quietHours.enabled ? 'On' : 'Off'}</button></div>
        <div className="apex-widget-quiet-times"><label>From <input type="time" value={quietHours.start} onChange={(event) => { if (validClockTime(event.target.value)) setQuietHours((current) => ({ ...current, start: event.target.value })); }} /></label><label>Until <input type="time" value={quietHours.end} onChange={(event) => { if (validClockTime(event.target.value)) setQuietHours((current) => ({ ...current, end: event.target.value })); }} /></label></div>
        <small>{quietActive ? 'Finding bubbles are quiet until ' + quietHours.end : 'Finding bubbles pause during these local hours.'} The amber count stays visible.</small>
      </div>}
    </div>

    {open && selected && <section className="apex-widget-panel" style={panelStyle} role="dialog" aria-label={`ApexAgent · ${selected.name}`} data-apex-agent-overlay="panel" ref={panelRef}>
      <header className="apex-widget-header"><div className="apex-widget-title"><strong>ApexAgent</strong><span>{selected.name}</span></div><div className="apex-widget-header-actions"><span className={`apex-widget-status status-${status}`}>{widgetStatusLabel(status)}</span><button onClick={closePanel} aria-label="Close ApexAgent">×</button></div></header>
      <div className="apex-widget-projects" aria-label="Choose project">
        {workspaces.filter((workspace) => !workspace.hidden).map((workspace) => {
          const monitor = monitorFor(monitors, workspace.id); const count = activeMonitorFindings(monitor).length; const itemStatus = widgetStatus(workspace, monitor, offlineWorkspaceIds);
          return <button key={workspace.id} className={workspace.id === workspaceId ? 'selected' : ''} aria-pressed={workspace.id === workspaceId} onClick={() => chooseProject(workspace.id)}><span className={`apex-widget-dot status-${itemStatus}`} /><span className="apex-widget-project-name">{workspace.name}</span>{count > 0 && <span className="apex-widget-project-count">{count}</span>}</button>;
        })}
      </div>
      <div className="apex-widget-body">{children ?? <div className="apex-widget-empty">ApexAgent conversation appears here.</div>}</div>
      {selectedMonitor && <footer className="apex-widget-footer">{status === 'failed' && selectedMonitor.error ? <span className="apex-widget-failed" title={selectedMonitor.error}>Last check failed: {checkFailureReason(selectedMonitor.error)}{onRetry && <button type="button" disabled={retry?.workspaceId === selectedMonitor.workspaceId && retry.state === 'sending'} title={retry?.workspaceId === selectedMonitor.workspaceId ? retry.message : undefined} onClick={() => {
        const id = selectedMonitor.workspaceId;
        setRetry({ workspaceId: id, state: 'sending' });
        onRetry(id).then(() => setRetry((value) => value?.workspaceId === id ? null : value), (error: unknown) => setRetry((value) => value?.workspaceId === id ? { workspaceId: id, state: 'failed', message: error instanceof Error ? error.message : String(error) } : value));
      }}>{retry?.workspaceId === selectedMonitor.workspaceId ? retry.state === 'sending' ? 'Retrying…' : 'Retry failed · try again' : 'Retry'}</button>}</span> : <span>{selectedMonitor.paused ? 'Paused' : selectedMonitor.completed ? 'Complete' : selectedMonitor.activeCheck ? 'Checking' : 'Watching'}</span>}<span>{selectedMonitor.files.length} files · {selectedMonitor.threads.length} chats</span></footer>}
    </section>}

    {selectedDropState && <div ref={dropRef} className={`apex-widget-drop-result edge-${position.edge} state-${selectedDropState.state}`} style={position.edge === 'left' ? { left: 84, top: dropTop } : { right: 84, top: dropTop }} role="status" data-apex-agent-overlay="drop-result"><span>{selectedDropState.state === 'adding' ? 'Adding…' : selectedDropState.state === 'added' ? 'Added' : selectedDropState.message}</span><button aria-label="Dismiss source message" onClick={() => setDropStates((previous) => { const next = { ...previous }; delete next[selectedDropOwner]; return next; })}>×</button></div>}
    {showBubble && activeBubble && activeBubbleWorkspace && <aside ref={bubbleRef} className={`apex-widget-bubble edge-${position.edge}`} style={bubbleStyle} data-apex-agent-overlay="bubble">
      <button className="apex-widget-bubble-close" aria-label="Dismiss finding bubble" onClick={() => setBubbleHidden((previous) => new Set(previous).add(bubbleKey))}>×</button>
      <strong>{activeBubbleWorkspace.name}</strong><p>{activeBubble.finding.summary}</p>
      {activeBubble.finding.evidence[0] && <small>{activeBubble.finding.evidence[0].label}</small>}
      {onReply && <form onSubmit={(event) => { event.preventDefault(); void sendReply(); }}><input aria-label="Reply to ApexAgent" placeholder="Reply…" value={replyText} onChange={(event) => setReplyDrafts((previous) => ({ ...previous, [bubbleKey]: event.target.value }))} /><button disabled={replyBusy === bubbleKey || !replyText.trim()}>{replyBusy === bubbleKey ? 'Sending…' : 'Send'}</button></form>}
      {replyErrors[bubbleKey] && <small className="apex-widget-reply-error" role="alert">{replyErrors[bubbleKey]}</small>}
      <button className="apex-widget-open-finding" onClick={() => onOpen(activeBubble.monitor.workspaceId)}>Open finding</button>
    </aside>}
  </div>;
}
