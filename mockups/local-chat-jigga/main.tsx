import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Avatar } from '../../src/Avatar';
import { ReasoningSlider } from '../../src/ReasoningSlider';
import { effortLabel } from '../../src/models';
import { SPEED_OPTIONS } from '../../src/speed';
import { ThreadList } from '../../src/phone/ThreadList';
import { ArrowUp, Camera, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Command, Folder, Laptop, Lock, MessageSquare, More, Plus, Settings, Terminal, X } from '../../src/phone/icons';
import type { Pane, Speed, Workspace } from '../../src/types';
import '../../src/styles.css';
import '../../src/phone/phone.css';
import './study.css';

// Sample data only. Nothing here is read from a real machine, and no model is ever contacted.
// Every "reply" is canned text that says it is a sample.
type Conn = 'connected' | 'reconnecting' | 'updating';
// After SSH setup a tool can be installed but not usable yet: it needs sign-in, or (Codex on Linux) bubblewrap, which needs an admin.
type ToolState = 'signin' | 'nobwrap';
const connText = (c: Conn) => (c === 'connected' ? 'Connected' : c === 'updating' ? 'Updating Deck · messages wait' : 'Reconnecting · messages wait');
type HostId = 'mac' | 'linux' | 'windows';
type Access = 'ask' | 'read' | 'full';
type Provider = 'Claude' | 'Codex' | 'DeepSeek' | 'Qwen';
type Profile = { name: string; provider: Provider; models: string[]; efforts: string[]; seed: string; color: string };
// One bot in one thread. Model, reasoning, speed and access belong to the thread, as they do today.
type Member = { name: string; model: string; effort: string; speed: Speed | ''; access: Access; left: number };
type Msg = { from: 'me' | 'notice' | string; text: string; queued?: boolean; suggest?: boolean; bot?: string };
// A chat and a Work thread are the same thing. The only difference: a Work thread has a folder.
type Thread = { id: string; title: string; host: HostId; folder?: string; age: string; archived?: boolean; movedTo?: string; movedFrom?: string; dismissed?: boolean; crew: Member[]; messages: Msg[]; working: Record<string, string> };

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const PROFILES: Record<string, Profile> = {
  Jigga: { name: 'Jigga', provider: 'Claude', models: ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'], efforts: CLAUDE_EFFORTS, seed: 'jigga', color: '#d97757' },
  Null: { name: 'Null', provider: 'Codex', models: ['gpt-5.5', 'gpt-5.5-mini'], efforts: CODEX_EFFORTS, seed: 'null', color: '#5aa9e6' },
  Forge: { name: 'Forge', provider: 'Codex', models: ['gpt-5.5', 'gpt-5.5-mini'], efforts: CODEX_EFFORTS, seed: 'forge', color: '#e6b85a' },
  deepgeek: { name: 'deepgeek', provider: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'], efforts: [], seed: 'deepgeek', color: '#8c7ae6' },
  Gwen: { name: 'Gwen', provider: 'Qwen', models: ['Qwen 9B (on this Mac)'], efforts: [], seed: 'gwen', color: '#4fc9a4' },
};
const hasSpeed = (p: Provider) => p === 'Claude' || p === 'Codex';
const ACCESS: { id: Access; text: string; long: string }[] = [
  { id: 'ask', text: 'Ask first', long: 'Ask first' }, { id: 'read', text: 'Read only', long: 'Read only' }, { id: 'full', text: 'Full', long: 'Full access' },
];
const accessName = (a: Access) => ACCESS.find((x) => x.id === a)!.long;

function Windows({ size = 18 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 5 11 4v7H3ZM13 4l8-1v8h-8ZM3 13h8v7l-8-1ZM13 13h8v8l-8-1Z" /></svg>; }
// Bots are saved on each machine, so each machine offers its own set.
const HOSTS: Record<HostId, { name: string; os: string; kind: 'mac' | 'server'; bots: string[]; icon: (p: { size?: number }) => ReactNode; folders: string[] }> = {
  mac: { name: 'Studio MacBook', os: 'macOS', kind: 'mac', bots: ['Jigga', 'Null', 'deepgeek', 'Gwen'], icon: Laptop, folders: ['~/Projects/apex-deck', '~/Projects/website'] },
  linux: { name: 'Apex-Terminal', os: 'Linux · headless', kind: 'server', bots: ['Jigga', 'Null', 'Forge', 'deepgeek'], icon: Terminal, folders: ['/home/demo/apex-deck', '/home/demo/website'] },
  windows: { name: 'Office PC', os: 'Windows', kind: 'server', bots: ['Null', 'Forge'], icon: Windows, folders: ['C:\\Projects\\apex-deck'] },
};
const HOST_IDS = Object.keys(HOSTS) as HostId[];

const member = (name: string, over: Partial<Member> = {}): Member => {
  const p = PROFILES[name];
  return { name, model: p.models[0], effort: p.efforts.includes('high') ? 'high' : '', speed: '', access: 'ask', left: 80, ...over };
};
const settingsLine = (m: Member) => {
  const p = PROFILES[m.name];
  return [p.provider, m.model, m.effort ? effortLabel(m.effort) : '', m.speed === 'fast' ? 'Fast' : ''].filter(Boolean).join(' · ');
};
const crewNames = (t: Thread) => t.crew.map((m) => m.name).join(', ');
const baseName = (path: string) => path.split(/[\\/]/).pop()!;

const START: Thread[] = [
  { id: 'sidebar', title: 'Why the sidebar cuts off names', host: 'linux', age: '2m', working: {},
    crew: [member('Jigga', { effort: 'xhigh', left: 64 }), member('Null', { speed: 'fast', left: 41 }), member('Forge', { model: 'gpt-5.5-mini', effort: 'medium', left: 88 })],
    messages: [
      { from: 'me', text: 'Why does the sidebar cut off long project names? Everyone weigh in.' },
      { from: 'Jigga', text: 'Sample reply. Most likely the row is a flex child without min-width: 0, so the name can’t shrink and gets clipped instead of ending in “…”.' },
      { from: 'Null', text: 'Sample reply. Agree with Jigga. The chip next to it also has no flex-shrink. I can patch both and run the tests, but this chat has no project folder.', suggest: true },
      { from: 'Forge', text: 'Sample reply. When someone patches it, check it at 320 px wide too. That’s where it breaks first.' },
      { from: 'me', text: '@Null can you make the patch?', queued: true },
    ] },
  { id: 'trip', title: 'Plan the Denver trip', host: 'mac', age: '1h', working: {},
    crew: [member('Jigga', { model: 'Sonnet 5.5', effort: 'medium', left: 92 }), member('deepgeek', { left: 70 })],
    messages: [
      { from: 'me', text: 'Three days in Denver in March. What should I book first?' },
      { from: 'Jigga', text: 'Sample reply. Flights first, then a place near Union Station so you can skip the car.' },
      { from: 'deepgeek', text: 'Sample reply. @Jigga midweek flights are usually cheaper in March. I’d add one snow day to the plan.' },
    ] },
  { id: 'notes', title: 'Tidy my meeting notes', host: 'windows', age: 'Tue', working: {}, crew: [member('Null'), member('Forge', { effort: 'low' })], messages: [] },
  { id: 'old', title: 'Last month’s ideas', host: 'mac', age: 'Sep 28', archived: true, working: {}, crew: [member('Jigga'), member('Gwen')], messages: [] },
  { id: 'w-tabs', title: 'Make the tabs taller', host: 'mac', folder: HOSTS.mac.folders[0], age: '5m', working: { Null: 'Running: npm run test:phone' },
    crew: [member('Null', { access: 'full', speed: 'fast', left: 33 }), member('deepgeek', { access: 'ask', left: 75 }), member('Jigga', { access: 'read', left: 58 })],
    messages: [
      { from: 'me', text: '@Null make the bottom tabs 44 pt tall. @Jigga review it when Null is done.' },
      { from: 'Jigga', text: 'Sample reply. I’m on Read only here, so I won’t edit. I’ll read Null’s change when the tests finish.' },
    ] },
];

// Each project folder belongs to one machine. The id carries the machine so a Work thread lands under the right heading.
const hostOfId = (hostId: string) => hostId.replace('sample-', '') as HostId;
const workspaceOf = (host: HostId, path: string): Workspace => ({ id: `${host}:${baseName(path)}`, name: baseName(path), path, hostId: `sample-${host}` });

/** Which bots a message goes to: the @names in it, or everyone when there are none. */
function addressed(text: string, crew: Member[]): string[] {
  if (/@everyone\b/i.test(text)) return crew.map((m) => m.name);
  const named = crew.filter((m) => new RegExp(`@${m.name}\\b`, 'i').test(text)).map((m) => m.name);
  return named.length ? named : crew.map((m) => m.name);
}

function App() {
  const [conn, setConn] = useState<Record<HostId, Conn>>({ mac: 'connected', linux: 'reconnecting', windows: 'connected' });
  // Which machines this phone has paired, and any label given while adding one. A label replaces the machine's own name.
  const [hosts, setHosts] = useState<HostId[]>(HOST_IDS);
  const [labels, setLabels] = useState<Partial<Record<HostId, string>>>({});
  const [tools, setTools] = useState<Partial<Record<HostId, Partial<Record<Provider, ToolState>>>>>({});
  const toolOf = (host: HostId, name: string) => tools[host]?.[PROFILES[name].provider];
  const ready = (host: HostId, name: string) => !toolOf(host, name);
  const toolsRef = useRef(tools); toolsRef.current = tools;
  const paired = hosts.length > 0;
  const nameOf = (id: HostId) => labels[id] ?? HOSTS[id].name;
  const [threads, setThreads] = useState<Thread[]>(START);
  // #sidebar opens that thread; #sidebar/bots, #sidebar/where or #sidebar/move also opens a sheet, so reviewers can link straight to a screen.
  const [hashThread, hashSheet] = location.hash.slice(1).split('/');
  const [open, setOpen] = useState<string | null>(START.some((t) => t.id === hashThread) ? hashThread : null);
  const [draft, setDraft] = useState('');
  type SheetKind = null | 'new' | 'newchat' | 'newwork' | 'where' | 'move' | 'add' | 'qr' | 'ssh' | 'sshrun' | 'bots' | 'bot';
  const [sheet, setSheet] = useState<SheetKind>(['where', 'move', 'bots'].includes(hashSheet) || ADD_SHEETS.includes(hashSheet) ? hashSheet as SheetKind : null);
  const [sshFail, setSshFail] = useState<SshFail>('none');
  const [server, setServer] = useState<ServerState>('fresh');
  const [botOpen, setBotOpen] = useState<string>('');
  const [crewFolded, setCrewFolded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [chatsFolded, setChatsFolded] = useState(false);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [last, setLast] = useState<{ host: HostId; crew: string[] }>({ host: 'mac', crew: ['Jigga', 'Null'] });
  // New chat starts from the last machine used, but only if it's still paired; otherwise the first paired one with its bots.
  // Bots that need sign-in (or bubblewrap) on that machine are never picked by default.
  const lastHost = hosts.includes(last.host) || !paired ? last.host : hosts[0];
  const lastCrew = last.crew.filter((n) => HOSTS[lastHost].bots.includes(n) && ready(lastHost, n));
  const lastPaired = { host: lastHost, crew: lastCrew.length ? lastCrew : HOSTS[lastHost].bots.filter((n) => ready(lastHost, n)).slice(0, 1) };
  const [note, setNote] = useState('');
  const [toast, setToast] = useState('');
  useEffect(() => { if (!note) return; setToast(note); const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); }, [note]);
  useEffect(() => { const reload = () => location.reload(); addEventListener('hashchange', reload); return () => removeEventListener('hashchange', reload); }, []);
  const timers = useRef<number[]>([]);
  // Timers (a Deck switch-over, a reconnect) read the latest threads, not the ones from when they were set.
  const threadsRef = useRef(threads); threadsRef.current = threads;
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const thread = threads.find((t) => t.id === open) ?? null;
  const edit = (id: string, fn: (t: Thread) => Thread) => setThreads((all) => all.map((t) => (t.id === id ? fn(t) : t)));
  const editMember = (id: string, name: string, change: Partial<Member>) => edit(id, (t) => ({ ...t, crew: t.crew.map((m) => (m.name === name ? { ...m, ...change } : m)) }));

  /** Sample turns: each addressed bot shows a working line, then a canned reply that names its settings. No model runs. */
  function answer(id: string, all: string[]) {
    // Same check as New chat, for every send path (typed, queued, after a move): a bot that needs sign-in or bubblewrap
    // on this machine gets nothing, and a notice says why. Read from refs so queued sends released later see current state.
    const at = threadsRef.current.find((t) => t.id === id)?.host;
    const blocked = at ? all.filter((n) => toolsRef.current[at]?.[PROFILES[n].provider]) : [];
    const names = all.filter((n) => !blocked.includes(n));
    if (at && blocked.length) edit(id, (t) => ({ ...t, messages: [...t.messages, ...blocked.map((n) => {
      const p = PROFILES[n].provider;
      return { from: 'notice', bot: n, text: toolsRef.current[at]?.[p] === 'signin' ? `${n} didn’t get this: ${p} needs sign-in on ${nameOf(at)}.` : `${n} didn’t get this: ${p} can’t chat on ${nameOf(at)} until an admin installs bubblewrap.` };
    })] }));
    if (!names.length) return;
    edit(id, (t) => ({ ...t, working: { ...t.working, ...Object.fromEntries(names.map((n) => [n, 'Thinking'])) } }));
    names.forEach((n, i) => {
      timers.current.push(window.setTimeout(() => edit(id, (t) => ({ ...t, working: { ...t.working, [n]: t.folder && t.crew.find((m) => m.name === n)?.access !== 'read' ? 'Reading the project' : 'Writing' } })), 700 + i * 500));
      timers.current.push(window.setTimeout(() => edit(id, (t) => {
        const m = t.crew.find((x) => x.name === n); if (!m || !(n in t.working)) return t;
        const { [n]: _, ...rest } = t.working;
        return { ...t, working: rest, messages: [...t.messages, { from: n, text: `Sample reply from ${n} (${settingsLine(m)}). No model was asked.` }] };
      }), 1900 + i * 1100));
    });
  }
  function setHost(id: HostId, next: Conn) {
    setConn((old) => ({ ...old, [id]: next }));
    if (next === 'connected') threadsRef.current.filter((t) => t.host === id && t.messages.some((m) => m.queued)).forEach((t) => {
      const waiting = t.messages.filter((m) => m.queued);
      edit(t.id, (x) => ({ ...x, messages: x.messages.map((m) => ({ ...m, queued: false })) }));
      answer(t.id, [...new Set(waiting.flatMap((m) => addressed(m.text, t.crew)))]);
    });
    setNote(next === 'connected' ? `${nameOf(id)} is back. Waiting messages went out (sample, no model).` : next === 'updating' ? `${nameOf(id)} is switching to the new Deck once its bots finish. Messages wait on the phone until then.` : `${nameOf(id)} dropped. Messages to it now wait on the phone.`);
  }
  function startThread(host: HostId, crew: string[], folder?: string) {
    const id = (folder ? 'w' : 'c') + Date.now();
    setThreads((all) => [{ id, title: folder ? 'New Work thread' : 'New chat', host, folder, age: 'Now', working: {}, crew: crew.map((n) => member(n)), messages: [] }, ...all]);
    setLast({ host, crew }); setOpen(id); setDraft(''); setSheet(null);
  }
  function moveHost(host: HostId) {
    if (!thread || thread.host === host) return;
    const stays = thread.crew.filter((m) => !HOSTS[host].bots.includes(m.name)).map((m) => m.name);
    const crew = thread.crew.filter((m) => HOSTS[host].bots.includes(m.name));
    edit(thread.id, (t) => ({ ...t, host, crew: crew.length ? crew : [member(HOSTS[host].bots[0])], working: {} }));
    setLast({ host, crew: crew.map((m) => m.name) });
    setNote(stays.length ? `${stays.join(' and ')} ${stays.length > 1 ? 'aren’t' : 'isn’t'} set up on ${nameOf(host)}, so ${stays.length > 1 ? 'they stay' : 'it stays'} behind.` : `The whole chat now runs on ${nameOf(host)}.`);
  }
  function send() {
    const text = draft.trim();
    if (!thread || !text) return;
    const waiting = conn[thread.host] !== 'connected';
    edit(thread.id, (t) => ({ ...t, age: 'Now', title: t.messages.length ? t.title : text.replace(/@\w+\s*/g, '').slice(0, 36) || t.title, messages: [...t.messages, { from: 'me', text, queued: waiting }] }));
    setDraft('');
    if (waiting) setNote(`Waiting for ${nameOf(thread.host)}. It sends by itself when the machine is back.`);
    else answer(thread.id, addressed(text, thread.crew));
  }
  /** Tap a bot in the bar: add or take away its @name, like the real bot bar. */
  function tag(name: string) {
    const re = new RegExp(`@${name}\\b\\s?`, 'i');
    setDraft((d) => (re.test(d) ? d.replace(re, '') : `${d.replace(/@everyone\b\s?/i, '')}${d && !d.endsWith(' ') ? ' ' : ''}@${name} `));
  }
  /** Sample sign-in: the real one opens the tool's sign-in page in Safari and the machine finishes it. Nothing is contacted here. */
  function signIn(host: HostId, name: string) {
    const provider = PROFILES[name].provider;
    setTools((t) => { const { [provider]: _, ...rest } = t[host] ?? {}; return { ...t, [host]: rest }; });
    setNote(`Sample: opens ${provider}’s sign-in page in Safari. After you approve, ${provider} is ready on ${nameOf(host)}.`);
  }
  const [moveFolder, setMoveFolder] = useState('');
  const [moveAccess, setMoveAccess] = useState<Record<string, Access>>({});
  function move() {
    if (!thread || !moveFolder) return;
    const id = 'w' + Date.now();
    setThreads((all) => [{ id, title: thread.title, host: thread.host, folder: moveFolder, age: 'Now', movedFrom: thread.id, working: {},
      crew: thread.crew.map((m) => ({ ...m, access: moveAccess[m.name] ?? 'ask' })), messages: thread.messages.filter((m) => !m.queued).map((m) => ({ ...m, suggest: false })) },
    ...all.map((t) => (t.id === thread.id ? { ...t, movedTo: id } : t))]);
    setSheet(null); setMoveFolder(''); setMoveAccess({}); setOpen(id);
  }

  const shown = threads.filter((t) => hosts.includes(t.host));
  const chats = shown.filter((t) => !t.folder && (showArchived || !t.archived));
  const archivedCount = shown.filter((t) => !t.folder && t.archived).length;
  const work = shown.filter((t) => t.folder);
  const projects = [...new Map(work.map((t) => { const w = workspaceOf(t.host, t.folder!); return [w.id, w] as const; })).values()];
  const panes: Pane[] = work.map((t) => ({ id: t.id, workspaceId: workspaceOf(t.host, t.folder!).id, kind: 'chat', title: t.title }));
  const bot = thread?.crew.find((m) => m.name === botOpen);

  const screen = thread ? <ThreadScreen thread={thread} conn={conn} hosts={hosts} nameOf={nameOf} draft={draft} folded={crewFolded}
    onDraft={setDraft} onSend={send} onTag={tag} onFold={setCrewFolded} onBack={() => { setOpen(null); setDraft(''); }}
    onBot={(n) => { setBotOpen(n); setSheet('bot'); }} onBots={() => setSheet('bots')} onWhere={() => thread.folder ? setNote('A Work thread stays with its folder. To use another machine, start a new one there.') : setSheet('where')}
    onMove={() => { setMoveAccess({}); setSheet('move'); }} onDismiss={() => edit(thread.id, (t) => ({ ...t, dismissed: true }))}
    onStop={(n) => edit(thread.id, (t) => { const { [n]: _, ...rest } = t.working; return { ...t, working: rest }; })}
    onUnqueue={(i) => edit(thread.id, (t) => ({ ...t, messages: t.messages.filter((_, j) => j !== i) }))}
    onOpen={(id) => setOpen(id)} onSwitch={(h) => moveHost(h)} onPlus={() => setNote('Files and tools: same + menu as every thread (not part of this study).')}
    toolOf={toolOf} onSignIn={(n) => signIn(thread.host, n)} />
    : <>
      <header className="ph-head">
        <h1 className="ph-large"><img className="ph-mark" src="/branding/mark.svg" alt="" width="26" height="26" />Threads</h1>
        <span className="ph-head-actions">
          <button type="button" className="ph-icon" aria-label="New" onClick={() => setSheet(paired ? 'new' : 'add')}><Plus size={22} /></button>
          <button type="button" className="ph-icon" aria-label="Settings" onClick={() => setNote('Settings is outside this study.')}><Settings size={20} /></button>
        </span>
      </header>
      <div className="jx-scroll">
        {!paired ? <main className="ph-content ph-tl"><div className="ph-tl-empty">
          <img src="/branding/mark.svg" alt="" width="88" height="88" />
          <strong>Group chats with the models on your computer</strong>
          <p>Add a Mac, Windows or Linux machine once: scan its code, or set up a server over SSH. No address, id or token to type.</p>
          <button type="button" className="primary ph-wide" onClick={() => setSheet('add')}>Add a machine</button>
        </div></main> : <>
          <section className="ph-content ph-tl jx-chats" aria-label="Chats">
            <div className="ph-tl-heading">
              <button type="button" className="ph-tl-p ph-tl-section" aria-expanded={!chatsFolded} onClick={() => setChatsFolded((v) => !v)}>
                <MessageSquare size={14} /><span className="ph-tl-pname">Chats</span>
                {chatsFolded && <span className="ph-tl-count">{chats.length}</span>}
                <span className="ph-tl-chev"><ChevronRight size={15} /></span>
              </button>
            </div>
            {!chatsFolded && chats.map((t) => {
              const H = { ...HOSTS[t.host], name: nameOf(t.host) }; const waiting = t.messages.some((m) => m.queued); const off = conn[t.host] !== 'connected'; const busy = Object.keys(t.working).length > 0;
              return <button key={t.id} type="button" className="ph-tl-thread" aria-label={`${t.title}. ${crewNames(t)} on ${H.name}`} onClick={() => { setOpen(t.id); setDraft(''); }}>
                {waiting ? <i className="ph-tl-dot wait" role="img" aria-label="Waiting to send" /> : busy ? <i className="ph-tl-dot work" role="img" aria-label="A bot is working" /> : null}
                <span className="ph-tl-l1"><span className="ph-tl-name">{t.title}</span><span className="ph-tl-age">{t.archived ? 'Archived' : t.age}</span></span>
                <span className="ph-tl-l2">
                  <span className="jx-stack" aria-hidden="true">{t.crew.slice(0, 3).map((m) => <Avatar key={m.name} seed={PROFILES[m.name].seed} color={PROFILES[m.name].color} size="sm" working={m.name in t.working} />)}</span>
                  {waiting ? <><span className="ph-tl-warn">Waiting</span><span>·</span></> : null}
                  <span className="ph-tl-where">{crewNames(t)}</span><span>·</span><i className={`jx-dot ${conn[t.host]}`} aria-hidden="true" /><span className="jx-host">{nameOf(t.host)}</span>{off && !waiting ? <><span>·</span><span className="ph-tl-warn">{conn[t.host] === 'updating' ? 'Updating…' : 'Connecting…'}</span></> : null}
                </span>
              </button>;
            })}
            {!chatsFolded && archivedCount > 0 && <button type="button" className="ph-tl-archived" onClick={() => setShowArchived((v) => !v)}>{showArchived ? 'Hide archived' : `Show ${archivedCount} archived`}</button>}
          </section>
          <ThreadList sections={{ pinned: [], projects: projects.map((w) => ({ workspace: w, panes: panes.filter((p) => p.workspaceId === w.id) })), recents: [], archived: [] }} workspaces={projects}
            links={hosts.map((id) => ({ id: `sample-${id}`, name: nameOf(id), kind: HOSTS[id].kind, status: conn[id] === 'connected' ? 'online' : 'connecting' }))}
            folded={folded} draft={null} waiting={{}} busy={Object.fromEntries(work.filter((t) => Object.keys(t.working).length).map((t) => [t.id, Object.keys(t.working)]))} nameOf={(x) => x} loaded covered={false} now={Date.now()}
            machineIcon={(hostId, size = 14) => { const Icon = HOSTS[hostOfId(hostId)]?.icon ?? Terminal; return <Icon size={size} />; }} onToggle={(id) => setFolded((v) => ({ ...v, [id]: !v[id] }))}
            onOpen={(id) => setOpen(id)} onThreadMenu={() => setNote('Hold menu: same as today.')} onProjectMenu={() => setNote('Project menu: same as today.')}
            onMachines={() => setSheet('add')} onRetry={(hostId) => setHost(hostOfId(hostId), 'connected')} archived={0} />
        </>}
      </div>
      <nav className="ph-tabs" aria-label="Sections">
        {([[Command, 'Agents'], [Terminal, 'Code'], [MessageSquare, 'Threads'], [Folder, 'Library']] as const).map(([Icon, label]) => <button key={label} type="button" className={label === 'Threads' ? 'on' : ''} aria-current={label === 'Threads' ? 'page' : undefined} onClick={() => label !== 'Threads' && setNote(`${label} tab is unchanged.`)}><Icon size={21} />{label}</button>)}
      </nav>
    </>;

  const sheetTitle: Record<Exclude<SheetKind, null>, string> = { new: 'New', newchat: 'New chat', newwork: 'New Work thread', where: 'Where this chat runs', move: 'Move to a Work thread', add: 'Add a machine', qr: 'Scan the code', ssh: 'Add a machine', sshrun: 'Setting up', bots: thread?.folder ? 'Bots in this thread' : 'Bots in this chat', bot: thread?.folder ? 'In this thread' : 'In this chat' };

  return <div className="jx-study">
    <header className="jx-top">
      <div><h1>Local chat · Jigga’s version · group chat</h1><p>Sample data. No machine is contacted, and every reply is canned text that says so.</p></div>
      <fieldset><legend>Try a machine dropping (each one on its own)</legend>
        {HOST_IDS.map((id) => <label key={id}>{nameOf(id)}<select value={conn[id]} onChange={(e) => setHost(id, e.target.value as Conn)}><option value="connected">Connected</option><option value="reconnecting">Reconnecting</option><option value="updating">Updating Deck</option></select></label>)}
        <button type="button" aria-pressed={!paired} onClick={() => { setHosts(paired ? [] : HOST_IDS); setLabels({}); setTools({}); setOpen(null); }}>{paired ? 'Show: nothing paired' : 'Show: paired'}</button>
        <label>SSH setup<select value={sshFail} onChange={(e) => setSshFail(e.target.value as SshFail)}>{SSH_FAILS.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>
        <label>Server<select value={server} onChange={(e) => setServer(e.target.value as ServerState)}>{SERVER_STATES.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>
      </fieldset>
    </header>
    <div className="jx-layout">
      <aside className="jx-notes">
        <h2>Every thread is a group chat</h2>
        <ol>
          <li><b>Chats and Work threads have the same bot bar.</b> The pills under the title are the bots in this thread. Tap one to @tag it. Hold one for its model, reasoning, speed and access. <b>@ Everyone</b> tags them all.</li>
          <li><b>No tag means everyone answers.</b> Open “Why the sidebar cuts off names”: Jigga, Null and Forge each replied in their own colour. Type “@” in the box to pick a bot.</li>
          <li><b>Settings are per bot, per thread.</b> Jigga is on Opus at xHigh, Null is on Fast, Forge is on mini. Each sample reply names the settings it would have used.</li>
          <li><b>Access only matters once there’s a folder.</b> In a chat, bots talk but can’t touch files, so Access is shown but locked. Move to a Work thread and you set each bot’s access on the way (open “Make the tabs taller”: Null Full access, deepgeek Ask first, Jigga Read only).</li>
          <li><b>The whole group runs on one machine.</b> Tap the title to move it. A bot that isn’t set up on the new machine stays behind, and the app says so.</li>
          <li><b>New chat picks the bots too.</b> + → New chat starts with your last group on your last machine. Change either before you start.</li>
        </ol>
        <h2>Add a machine</h2>
        <ol>
          <li><b>One switch: QR code | Remote SSH.</b> No Mac/Server pick, no Id, no address, no token. The name and id come from the machine. Open it with + while “nothing paired” is shown, or link <code>#/add</code> and <code>#/ssh</code>.</li>
          <li><b>SSH runs silently after one Connect tap.</b> The list ticks through on its own: reach the server, check and save its key (before any sign-in is sent), sign in, find the system, install or update Deck, bubblewrap, start Deck, AI tools, pair, sign out. Chats then use the same paired link as QR.</li>
          <li><b>No questions.</b> No fingerprint screen (trusted on first use, shown as a line), no install or update prompt, no “where is apex-daemon?”. It stops only on a real failure. Try each with the <b>SSH setup</b> and <b>Server</b> pickers above.</li>
          <li><b>Updates never cut a reply off.</b> Pick <b>Server: Old Deck, bots replying</b>: the new version is installed but Deck only switches when the bots finish. Until then the machine shows <b>Updating Deck</b> and messages wait on the phone (the sample bots finish after 8 s).</li>
          <li><b>Tools that need sign-in stay marked.</b> After a fresh setup, Claude and Codex show “needs sign-in” in New chat, the bot list and bot settings, with a <b>Sign in</b> button. With no password (no sudo), Codex shows it needs bubblewrap and can’t be picked.</li>
          <li><b>Try it from “nothing paired”:</b> add it with a Label, and the Chats list and Machines show only that machine, under your label, as Connected.</li>
        </ol>
        <p><b>Acceptance checks (real iPhone):</b></p>
        <ol>
          <li>A passphrase-protected OpenSSH <b>ed25519</b> key imports from Files and unlocks with the right passphrase.</li>
          <li>A wrong passphrase says so and sends nothing to the server.</li>
          <li>One “After setup” choice, default <b>Forget sign-in</b>: Deck’s imported copy of the key, the passphrase and the password are gone from the phone (Deck’s files, Keychain, memory) once setup ends. The original key file in Files is not touched. <b>Keep with Face ID</b> stores them in the Keychain, readable only after Face ID.</li>
          <li>An <b>unencrypted</b> ed25519 key imports and connects with no passphrase box shown.</li>
          <li><b>Password only</b> (no key) signs in where the server allows it; where it doesn’t, the error says to use a key and nothing changes.</li>
          <li>Typing <code>https://host/</code> in IP or host connects to the bare host and says so. <code>host:2222</code> and <code>[2001:db8::1]:2222</code> keep their port; a bare IPv6 address like <code>2001:db8::1</code> is left whole. Ports outside 1–65535, and malformed ones like <code>host:abc</code> or <code>host:-1</code>, are refused before connecting.</li>
          <li>The Label, when given, is the machine’s name in Chats, Machines and the New chat / move pickers; blank uses the machine’s own name. Those pickers only offer paired machines.</li>
          <li>No startup snippet and no prompts: one Connect tap runs the whole list. The only programs run are the setup steps shown in the list.</li>
          <li><b>Fresh server</b> (Linux x86_64 and arm64): Deck is downloaded, its checksum checked, installed to start on boot, started and paired with no questions. A download that fails its check installs nothing.</li>
          <li><b>Admin rights:</b> the typed password is used for sudo; with no password (or a refused one) Deck installs just for that user, keeps running after sign-out, and bubblewrap is reported as skipped. Never asks. Afterwards Codex on that machine shows it needs bubblewrap and can’t be picked.</li>
          <li><b>Old Deck, bots idle:</b> updates and restarts. <b>Bots replying:</b> installs the update, keeps the old Deck running, and switches only after every reply finishes; no reply is cut off. Until the switch the machine shows Updating Deck in Chats and on the phone, and messages to it wait; they send by themselves after.</li>
          <li><b>Existing Deck service</b> (Apex-Terminal’s <code>apex-daemon@user</code>): found and updated in place, never a second copy.</li>
          <li><b>AI tools:</b> missing Claude/Codex are installed silently and show “Needs sign-in” in New chat, the bot list and bot settings, each with a Sign in button; they can’t be picked until signed in. Sign-in never blocks setup. A chat that already has such a bot (moved there, or a queued message) doesn’t send to it: a line says why, with Sign in where that helps.</li>
          <li>An unsupported system (e.g. FreeBSD) stops with a plain message and installs nothing.</li>
          <li>A file that isn’t an OpenSSH private key (a .pub, a PuTTY .ppk, junk) is refused on import with a plain message.</li>
          <li>When the server refuses the key, the phone says so and nothing changes on the server.</li>
          <li>The server key is checked before signing in. First connect saves it with no prompt and shows it as a line; a changed key stops setup before the key, password or passphrase is sent, with no way to continue.</li>
          <li>The pairing is saved on the phone the moment the server pairs it, not when Done is pressed. Closing the sheet after that keeps it.</li>
          <li>Kill the app at each setup step, then reopen: before pairing, nothing was added to the phone; after, the machine is there once. Connecting again picks up where it stopped (no second Deck install) and reuses the same pairing request, so the server never lists the phone twice.</li>
          <li>After setup the SSH session is closed. The machine shows in Chats as Connected over the paired link and stays reachable with SSH turned off on the server.</li>
          <li>Unreachable host, refused sign-in, changed key, unsupported system and a failed download each stop at their line in the list with a plain error and leave nothing half-paired.</li>
        </ol>
        <p className="jx-src">Built from the real phone header, bot bar (ph-crew), avatars, “working” rows with Stop, @ picker, bot sheet with the real reasoning slider and Speed control, bot list, banners, sheets and composer, plus the real ThreadList for Projects.</p>
      </aside>
      <div className="ph-app jx-phone">
        <div className="phone-frame">
          <div className="jx-clock" aria-hidden="true">9:41</div>
          {screen}
          {toast && !sheet && <div className="ph-toast" role="status"><span>{toast}</span><button type="button" aria-label="Dismiss" onClick={() => setToast('')}><X size={16} /></button></div>}
          {sheet && <Sheet title={sheetTitle[sheet]} onClose={() => { setSheet(null); setMoveFolder(''); }}>
            {sheet === 'new' && <div className="ph-list">
              <button type="button" className="ph-srow" onClick={() => setSheet('newchat')}><span className="ph-srow-icon"><MessageSquare size={18} /></span><span className="ph-grow"><strong>New chat</strong><small>{lastPaired.crew.join(', ')} on {nameOf(lastPaired.host)}. No folder.</small></span><ChevronRight size={16} /></button>
              <button type="button" className="ph-srow" onClick={() => setSheet('newwork')}><span className="ph-srow-icon"><Folder size={18} /></span><span className="ph-grow"><strong>New Work thread</strong><small>Pick a folder. Bots can read or edit files there.</small></span><ChevronRight size={16} /></button>
            </div>}
            {(sheet === 'newchat' || sheet === 'newwork') && <NewThread work={sheet === 'newwork'} conn={conn} hosts={hosts} nameOf={nameOf} last={lastPaired} toolOf={toolOf} onSignIn={signIn} onStart={startThread} />}
            {sheet === 'where' && thread && <>
              <p className="ph-sheet-text">The whole group moves with the chat. Only machines you’ve paired show here.</p>
              <div className="ph-list">{hosts.map((id) => { const H = HOSTS[id]; const missing = thread.crew.filter((m) => !H.bots.includes(m.name)).map((m) => m.name); return <button key={id} type="button" className="ph-srow" aria-pressed={thread.host === id} onClick={() => moveHost(id)}>
                <span className="ph-srow-icon"><H.icon size={18} /></span>
                <span className="ph-grow"><strong>{nameOf(id)}</strong><small><i className={`jx-dot ${conn[id]}`} aria-hidden="true" /> {connText(conn[id])} · {H.os}</small>{missing.length > 0 && thread.host !== id && <small className="ph-amber">{missing.join(', ')} not set up here</small>}</span>
                {thread.host === id && <Check size={18} />}
              </button>; })}</div>
              <button type="button" className="primary ph-wide jx-done" onClick={() => setSheet(null)}>Done</button>
            </>}
            {sheet === 'bots' && thread && <>
              <div className="ph-bot-list">{thread.crew.map((m) => <div className="ph-bot-entry" key={m.name}><div className="ph-bot-row">
                <button type="button" className="ph-bot-info" onClick={() => { setBotOpen(m.name); setSheet('bot'); }}>
                  <Avatar seed={PROFILES[m.name].seed} color={PROFILES[m.name].color} size="md" working={m.name in thread.working} />
                  <span className="ph-bot-label"><strong>{m.name}</strong><small>{settingsLine(m)}{thread.folder ? ` · ${accessName(m.access)}` : ''}</small><ToolNote state={toolOf(thread.host, m.name)} provider={PROFILES[m.name].provider} /></span>
                </button>
                {toolOf(thread.host, m.name) === 'signin' && <button type="button" className="ph-plain" onClick={() => signIn(thread.host, m.name)}>Sign in</button>}
                <button type="button" className="ph-bot-action remove" aria-label={`Remove ${m.name}`} disabled={thread.crew.length < 2} onClick={() => edit(thread.id, (t) => ({ ...t, crew: t.crew.filter((x) => x.name !== m.name) }))}><span aria-hidden="true">−</span></button>
              </div></div>)}</div>
              {HOSTS[thread.host].bots.some((n) => !thread.crew.some((m) => m.name === n)) && <>
                <div className="ph-section">Add from {nameOf(thread.host)}</div>
                <div className="ph-bot-list">{HOSTS[thread.host].bots.filter((n) => !thread.crew.some((m) => m.name === n)).map((n) => <div className="ph-bot-entry" key={n}><div className="ph-bot-row">
                  <span className="ph-bot-info"><Avatar seed={PROFILES[n].seed} color={PROFILES[n].color} size="md" /><span className="ph-bot-label"><strong>{n}</strong><small>{settingsLine(member(n))}</small><ToolNote state={toolOf(thread.host, n)} provider={PROFILES[n].provider} /></span></span>
                  {toolOf(thread.host, n) === 'signin' ? <button type="button" className="ph-plain" onClick={() => signIn(thread.host, n)}>Sign in</button>
                    : <button type="button" className="ph-bot-action" aria-label={`Add ${n}`} disabled={!ready(thread.host, n)} onClick={() => edit(thread.id, (t) => ({ ...t, crew: [...t.crew, member(n)] }))}><Plus size={18} /></button>}
                </div></div>)}</div>
              </>}
              <p className="ph-sheet-text ph-quiet">Bots are set up on each machine, so this list shows the ones on {nameOf(thread.host)}.</p>
            </>}
            {sheet === 'bot' && thread && bot && <BotSheet thread={thread} m={bot} nameOf={nameOf} conn={conn[thread.host]} tool={toolOf(thread.host, bot.name)} onSignIn={() => signIn(thread.host, bot.name)} onChange={(c) => editMember(thread.id, bot.name, c)}
              onMention={() => { tag(bot.name); setSheet(null); }} onStop={() => edit(thread.id, (t) => { const { [bot.name]: _, ...rest } = t.working; return { ...t, working: rest }; })}
              onMove={() => { setMoveAccess({}); setSheet('move'); }} />}
            {sheet === 'move' && thread && <>
              <p className="ph-sheet-text">Pick a folder on <b>{nameOf(thread.host)}</b>. The Work thread starts with this chat’s messages and the same bots. This chat keeps a link to it.</p>
              <div className="ph-list">{HOSTS[thread.host].folders.map((f) => <button key={f} type="button" className="ph-srow" aria-pressed={moveFolder === f} onClick={() => setMoveFolder(f)}><span className="ph-srow-icon"><Folder size={18} /></span><span className="ph-grow"><strong>{baseName(f)}</strong><small>{f}</small></span>{moveFolder === f && <Check size={18} />}</button>)}</div>
              <div className="ph-section">What each bot may do in the folder</div>
              <div className="ph-bot-list jx-access-list">{thread.crew.map((m) => <div className="ph-bot-entry" key={m.name}><div className="ph-bot-row">
                <span className="ph-bot-info"><Avatar seed={PROFILES[m.name].seed} color={PROFILES[m.name].color} size="sm" /><span className="ph-bot-label"><strong>{m.name}</strong></span></span>
                <div className="ph-segment jx-seg-sm" role="radiogroup" aria-label={`${m.name} access`}>{ACCESS.map((a) => <button key={a.id} type="button" role="radio" aria-checked={(moveAccess[m.name] ?? 'ask') === a.id} onClick={() => setMoveAccess((v) => ({ ...v, [m.name]: a.id }))}>{a.text}</button>)}</div>
              </div></div>)}</div>
              {conn[thread.host] !== 'connected' && <p className="ph-caption warn">{nameOf(thread.host)} is reconnecting. You can pick now; it moves when it’s back.</p>}
              <button type="button" className="primary ph-wide jx-done" disabled={!moveFolder} onClick={move}>{moveFolder ? `Move to ${baseName(moveFolder)}` : 'Pick a folder'}</button>
            </>}
            {ADD_SHEETS.includes(sheet) && <AddMachine step={sheet as AddStep} fail={sshFail} server={server} onStep={setSheet} onPaired={(id, label, after) => {
              const shown = label || HOSTS[id].name;
              setHosts((h) => (h.includes(id) ? h : [...h, id]));
              if (label) setLabels((l) => ({ ...l, [id]: label }));
              setTools((t) => ({ ...t, [id]: after.tools }));
              // Bots replying on the old Deck: the machine stays "Updating Deck" and messages wait until the switch. Sample: the bots finish after 8 s.
              if (after.updating) {
                setConn((old) => ({ ...old, [id]: 'updating' }));
                timers.current.push(window.setTimeout(() => setHost(id, 'connected'), 8000));
                setNote(`${shown} added. It switches to the new Deck once its bots finish replying; messages wait on the phone until then.`);
              } else {
                setConn((old) => ({ ...old, [id]: 'connected' }));
                setNote(`${shown} added and Connected. Chats now reach it over the paired link, not SSH.`);
              }
            }} onDone={() => setSheet(null)} />}
          </Sheet>}
        </div>
      </div>
      <aside className="jx-notes jx-right">
        <h2>Same idea on the desktop</h2>
        <p>The desktop sidebar keeps <b>Chats</b> above <b>Projects</b>, and a chat opens with the same bot chips, @ picker and per-bot settings a project thread has today. Only there does “This Mac” appear, because it’s true there.</p>
        <p>Try it: in a chat, send a message with no tag, then one with <b>@Forge</b>. Hold a bot pill to change its reasoning or speed, then send again and read what its sample reply says.</p>
        <div role="status" className="jx-status">{note || 'Tap around. Replies here are canned samples, never a model.'}</div>
      </aside>
    </div>
  </div>;
}

function ThreadScreen(props: { thread: Thread; conn: Record<HostId, Conn>; hosts: HostId[]; nameOf(id: HostId): string; draft: string; folded: boolean; onDraft(v: string): void; onSend(): void; onTag(n: string): void; onFold(v: boolean): void; onBack(): void; onBot(n: string): void; onBots(): void; onWhere(): void; onMove(): void; onDismiss(): void; onStop(n: string): void; onUnqueue(i: number): void; onOpen(id: string): void; onSwitch(h: HostId): void; onPlus(): void; toolOf(host: HostId, n: string): ToolState | undefined; onSignIn(n: string): void }) {
  const t = props.thread; const H = { ...HOSTS[t.host], name: props.nameOf(t.host) }; const down = props.conn[t.host] !== 'connected';
  const backup = props.hosts.find((h) => h !== t.host && props.conn[h] === 'connected' && t.crew.some((m) => HOSTS[h].bots.includes(m.name)));
  const queued = t.messages.filter((m) => m.queued).length;
  const to = addressed(props.draft, t.crew);
  const tagged = props.draft.trim() !== '' && t.crew.some((m) => new RegExp(`@${m.name}\\b`, 'i').test(props.draft));
  const everyone = !tagged;
  const picking = /(?:^|\s)@(\w*)$/.exec(props.draft);
  const picks = picking ? [{ name: 'everyone', label: 'All of them' }, ...t.crew.map((m) => ({ name: m.name, label: PROFILES[m.name].provider }))].filter((p) => p.name.toLowerCase().startsWith(picking[1].toLowerCase())) : [];
  const hold = useRef<number>(0); const held = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [t.messages.length, Object.keys(t.working).length]);
  const by = (n: string, live = false) => <div className="ph-by" style={{ '--agent-color': PROFILES[n]?.color } as CSSProperties}><Avatar seed={PROFILES[n]?.seed ?? n} color={PROFILES[n]?.color ?? '#888'} size="sm" working={live} /><span>{n}</span></div>;
  const from = t.movedFrom ? t.movedFrom : null;
  return <>
    <header className="ph-nav">
      <button type="button" className="ph-icon ph-nav-back" aria-label="Back to Threads" onClick={props.onBack}><ChevronLeft size={26} /></button>
      <button type="button" className="ph-nav-title" aria-label={`${t.title}. ${t.folder ? baseName(t.folder) : 'Chat'} on ${H.name}. Change where this runs`} onClick={props.onWhere}>
        <h2>{t.title}</h2>
        <p className="ph-context"><i className={`jx-dot ${props.conn[t.host]}`} aria-hidden="true" /><H.icon size={11} /><span className="ph-context-project">{t.folder ? baseName(t.folder) : 'Chat'}</span><span className="ph-context-machine">· {H.name}</span><ChevronDown size={12} /></p>
      </button>
      {props.folded && <button type="button" className="ph-cluster" aria-label={`Show the bots: ${crewNames(t)}`} onClick={() => props.onFold(false)}>
        {t.crew.slice(0, 3).map((m) => <Avatar key={m.name} seed={PROFILES[m.name].seed} color={PROFILES[m.name].color} size="sm" working={m.name in t.working} />)}
        {t.crew.length > 3 && <b>+{t.crew.length - 3}</b>}
      </button>}
      <button type="button" className="ph-icon" aria-label="Bots in this thread" onClick={props.onBots}><More size={20} /></button>
    </header>
    <div className={`ph-crew${props.folded ? ' shut' : ''}`} aria-hidden={props.folded}>
      <div className="ph-crew-row" role="group" aria-label="Bots in this thread">
        {t.crew.length > 1 && <button type="button" className={`ph-crew-pill${everyone ? ' to' : ''}`} aria-label={everyone ? 'Everyone. Answers your next message' : 'Tag everyone'} onClick={() => props.onDraft(props.draft.replace(/@\w+\s?/g, ''))}>
          <span className="ph-crew-chip"><span className="ph-mention-all" aria-hidden="true">@</span>Everyone</span>
        </button>}
        {t.crew.map((m) => {
          const P = PROFILES[m.name]; const next = !everyone && to.includes(m.name); const live = m.name in t.working;
          return <button key={m.name} type="button" className={`ph-crew-pill${next ? ' to' : ''}`} style={{ '--who': P.color } as CSSProperties}
            aria-label={`${m.name}${live ? ', working' : next ? ', answers your next message' : ''}, ${m.left}% context left. Tap to tag. Hold for settings`}
            onPointerDown={() => { held.current = false; hold.current = window.setTimeout(() => { held.current = true; props.onBot(m.name); }, 450); }}
            onPointerUp={() => clearTimeout(hold.current)} onPointerLeave={() => clearTimeout(hold.current)}
            onContextMenu={(e) => { e.preventDefault(); props.onBot(m.name); }}
            onClick={() => { if (!held.current) props.onTag(m.name); }}>
            <span className="ph-crew-chip">
              <span className="ph-crew-face"><Avatar seed={P.seed} color={P.color} size="sm" working={live} /></span>
              <span className="ph-crew-name">{m.name}<i className={`ph-crew-meter${m.left < 35 ? ' low' : ''}`} style={{ '--left': `${m.left}%` } as CSSProperties} /></span>
            </span>
            <i className="ph-crew-grab" aria-hidden="true" />
          </button>;
        })}
      </div>
      <button type="button" className="ph-icon ph-crew-fold" aria-label="Fold the bots into the title bar" onClick={() => props.onFold(true)}><ChevronUp size={18} /></button>
    </div>
    <main className="ph-content ph-chat">
      {down && <div className="ph-banner warn" role="status">
        <strong>{props.conn[t.host] === 'updating' ? `${H.name} is updating Deck` : `${H.name} is reconnecting`}</strong>
        <p>{props.conn[t.host] === 'updating' ? (queued ? `${queued} message${queued > 1 ? 's' : ''} waiting on this phone. They send by themselves once the bots there finish and Deck switches over.` : 'Deck switches over once the bots there finish replying. Messages wait here until then.')
          : queued ? `${queued} message${queued > 1 ? 's' : ''} waiting on this phone. They send by themselves when it’s back.` : 'You can keep typing. Messages wait here and send when it’s back.'}</p>
        {backup && !t.folder && <div className="ph-banner-actions"><button type="button" onClick={() => props.onSwitch(backup)}>Move this chat to {props.nameOf(backup)}</button></div>}
      </div>}
      {t.movedTo && <div className="ph-banner"><strong>Continued as a Work thread</strong><p>Same bots, now with a folder. This chat stays as it was.</p><div className="ph-banner-actions"><button type="button" onClick={() => props.onOpen(t.movedTo!)}>Open Work thread</button></div></div>}
      {from && <div className="ph-banner"><strong>Moved from a chat</strong><p>Its messages and bots came along. Access is set per bot (hold a pill).</p><div className="ph-banner-actions"><button type="button" onClick={() => props.onOpen(from)}>Open the chat</button></div></div>}
      {t.messages.length === 0 && Object.keys(t.working).length === 0 && <div className="ph-empty"><MessageSquare size={30} /><h3>{t.folder ? 'What are we working on?' : 'Start the group chat'}</h3><p>{crewNames(t)} · {H.name}{t.folder && <><br />{t.folder}</>}</p></div>}
      {t.messages.map((m, i) => m.from === 'notice' ? (
        <section key={i} className="jx-suggest jx-notice" role="status"><span className="ph-amber">{m.text}</span>
          {m.bot && props.toolOf(t.host, m.bot) === 'signin' && <button type="button" className="ph-plain" onClick={() => props.onSignIn(m.bot!)}>Sign in</button>}</section>
      ) : m.from === 'me' ? (
        m.queued ? <section key={i} className="ph-queued"><div className="ph-msg human"><p>{m.text}</p></div>
          <div className="ph-queued-meta"><span className="ph-queued-line" role="status">Waiting for {H.name}</span><span className="ph-queued-actions"><button type="button" className="ph-queued-x" aria-label={`Remove waiting message: ${m.text}`} onClick={() => props.onUnqueue(i)}><X size={15} /></button></span></div></section>
          : <section key={i} className="ph-said mine"><div className="ph-msg human"><p>{m.text}</p></div></section>
      ) : (
        <section key={i} className="ph-said"><div className="ph-msg">{by(m.from)}<div className="ph-md"><p>{m.text}</p></div></div>
          {m.suggest && !t.folder && !t.movedTo && !t.dismissed && <div className="jx-suggest">
            <Folder size={15} /><span>This needs a project folder.</span>
            <button type="button" className="ph-plain" onClick={props.onMove}>Move to a Work thread</button>
            <button type="button" className="ph-plain jx-quiet" onClick={props.onDismiss}>Not now</button>
          </div>}
        </section>
      ))}
      {Object.entries(t.working).map(([n, words]) => <section key={`w-${n}`} className="ph-msg ph-live" aria-busy="true">
        {by(n, true)}
        <div className="ph-working">
          <span className="ph-working-toggle"><span className="working-dots" aria-hidden="true"><i /><i /><i /></span><span className="ph-grow ph-ellipsis" role="status">{/^(Thinking|Writing)$/.test(words) ? `${n} is ${words.toLowerCase()}…` : words}</span></span>
          <button type="button" className="ph-stop" aria-label={`Stop ${n}`} onClick={() => props.onStop(n)}>Stop</button>
        </div>
      </section>)}
      <div ref={endRef} />
    </main>
    <form className="ph-composer" onSubmit={(e) => { e.preventDefault(); props.onSend(); }}>
      {picks.length > 0 && <div className="ph-mentions" role="listbox" aria-label="Mention a bot">
        {picks.map((p) => <button key={p.name} type="button" role="option" aria-selected="false" className="ph-mention" onMouseDown={(e) => e.preventDefault()} onClick={() => props.onDraft(props.draft.replace(/@\w*$/, `@${p.name === 'everyone' ? 'everyone' : p.name} `))}>
          {p.name === 'everyone' ? <span className="ph-mention-all" aria-hidden="true">@</span> : <Avatar seed={PROFILES[p.name].seed} color={PROFILES[p.name].color} size="sm" />}
          <span>{p.name === 'everyone' ? 'Everyone' : p.name}</span><small>{p.label}</small>
        </button>)}
      </div>}
      <div className="ph-compose-row">
        <button type="button" className="ph-add" aria-label="Add files or tools" onClick={props.onPlus}><Plus size={22} /></button>
        <div className="ph-input">
          <textarea rows={1} aria-label="Message" value={props.draft} onChange={(e) => props.onDraft(e.target.value)} placeholder={down ? `Waits for ${H.name}…` : everyone ? 'Message everyone…' : `Message ${to.join(', ')}…`} />
          <button type="submit" className="ph-send" aria-label={down ? `Queue for ${H.name}` : `Send to ${to.join(', ')}`} disabled={!props.draft.trim()}><ArrowUp size={21} /></button>
        </div>
      </div>
    </form>
  </>;
}

function BotSheet({ thread, m, nameOf, conn, tool, onSignIn, onChange, onMention, onStop, onMove }: { thread: Thread; m: Member; nameOf(id: HostId): string; conn: Conn; tool?: ToolState; onSignIn(): void; onChange(c: Partial<Member>): void; onMention(): void; onStop(): void; onMove(): void }) {
  const P = PROFILES[m.name]; const H = { ...HOSTS[thread.host], name: nameOf(thread.host) }; const live = m.name in thread.working;
  const down = conn !== 'connected'; const waitText = conn === 'updating' ? `${H.name} is updating Deck` : `${H.name} is reconnecting`;
  const [saved, setSaved] = useState(false);
  const change = (c: Partial<Member>) => { onChange(c); setSaved(true); };
  return <>
    <div className="ph-bot-head" style={{ '--agent-color': P.color } as CSSProperties}>
      <Avatar seed={P.seed} color={P.color} size="lg" working={live} />
      <span className="ph-grow"><strong>{m.name}</strong><small>{settingsLine(m)}</small><small className={down || tool ? 'ph-amber' : undefined}>{down ? waitText : tool === 'signin' ? `Needs sign-in on ${H.name}` : tool === 'nobwrap' ? `Can’t chat on ${H.name} yet` : live ? `Working on ${H.name}` : `Ready on ${H.name}`}</small></span>
    </div>
    {tool && <div className="ph-banner warn" role="status"><strong>{tool === 'signin' ? `${P.provider} needs sign-in on ${H.name}` : `${P.provider} needs bubblewrap on ${H.name}`}</strong><p>{tool === 'signin' ? 'It was installed during setup. Sign in once and it can reply here.' : 'Setup had no admin rights, so bubblewrap was skipped. An admin can install it; nothing on the phone fixes this.'}</p>{tool === 'signin' && <div className="ph-banner-actions"><button type="button" onClick={onSignIn}>Sign in to {P.provider}</button></div>}</div>}
    <div className="ph-card ph-meters" role="group" aria-label={`What ${m.name} has left`} style={{ '--who': P.color } as CSSProperties}>
      <div className={`ph-meter${m.left < 35 ? ' low' : ''}`}><p><span>Context left</span><b>{m.left}%{m.left < 35 && ' low'}</b></p><span className="ph-meter-track" aria-hidden="true"><i style={{ width: `${m.left}%` }} /></span><small>Sample number.</small></div>
    </div>
    <div className="ph-section">Model and reasoning</div>
    <fieldset className="ph-group ph-turn" disabled={down}>
      <div className="jx-field"><strong>Model</strong>
        <div className="ph-segment" role="radiogroup" aria-label="Model">{P.models.map((x) => <button key={x} type="button" role="radio" aria-checked={m.model === x} onClick={() => change({ model: x })}>{x.replace(' (on this Mac)', '')}</button>)}</div>
      </div>
      {P.efforts.length > 0 ? <div className="ph-reasoning"><ReasoningSlider efforts={P.efforts} value={m.effort} onCommit={(v) => change({ effort: v })} /></div>
        : <p className="ph-sheet-text ph-quiet jx-pad">{P.provider} has no reasoning level to pick.</p>}
      {hasSpeed(P.provider) && <div className="ph-speed"><strong>Speed</strong>
        <div className="ph-segment" role="radiogroup" aria-label="Speed">{SPEED_OPTIONS.map((o) => <button key={o.value || 'default'} type="button" role="radio" aria-checked={m.speed === o.value} title={o.title} onClick={() => change({ speed: o.value })}>{o.text}</button>)}</div>
        <small>Fast answers sooner and uses more of your plan.</small>
      </div>}
    </fieldset>
    <div className="ph-section">Access</div>
    <fieldset className="ph-group ph-turn jx-field" disabled={down || !thread.folder}>
      <div className="ph-segment" role="radiogroup" aria-label="Access">{ACCESS.map((a) => <button key={a.id} type="button" role="radio" aria-checked={m.access === a.id} onClick={() => change({ access: a.id })}>{a.long}</button>)}</div>
    </fieldset>
    {thread.folder ? <p className="ph-sheet-text ph-quiet">In {baseName(thread.folder)} on {H.name}. Ask first asks you on this phone before each edit or command.</p>
      : <p className="ph-sheet-text ph-quiet">This chat has no folder, so {m.name} can talk but can’t touch files. <button type="button" className="ph-plain jx-inline" onClick={onMove}>Move to a Work thread</button> to give it access.</p>}
    <p className={`ph-sheet-text ph-turn-note${down ? ' ph-amber' : ''}`} role="status">{down ? `${waitText}. Settings can change once it’s back.` : saved ? (live ? `Saved. ${m.name} finishes this reply first, then uses it.` : `Saved. ${m.name} uses it from its next reply.`) : 'Changes save as you pick them, for this thread only.'}</p>
    <button type="button" className="primary ph-wide" onClick={onMention}>Mention {m.name}</button>
    {live && !down && <button type="button" className="ph-wide jx-done" onClick={onStop}>Stop {m.name}</button>}
  </>;
}

function NewThread({ work, conn, hosts, nameOf, last, toolOf, onSignIn, onStart }: { work: boolean; conn: Record<HostId, Conn>; hosts: HostId[]; nameOf(id: HostId): string; last: { host: HostId; crew: string[] }; toolOf(host: HostId, name: string): ToolState | undefined; onSignIn(host: HostId, name: string): void; onStart(host: HostId, crew: string[], folder?: string): void }) {
  const [host, setHost] = useState<HostId>(last.host);
  const [crew, setCrew] = useState<string[]>(last.crew.filter((n) => HOSTS[last.host].bots.includes(n)));
  const usable = (h: HostId, n: string) => !toolOf(h, n);
  const [folder, setFolder] = useState(work ? HOSTS[last.host].folders[0] : '');
  const pick = (h: HostId) => { setHost(h); setCrew((c) => { const kept = c.filter((n) => HOSTS[h].bots.includes(n) && usable(h, n)); return kept.length ? kept : HOSTS[h].bots.filter((n) => usable(h, n)).slice(0, 1); }); if (work) setFolder(HOSTS[h].folders[0]); };
  return <>
    <div className="ph-section">Machine</div>
    <div className="ph-list">{hosts.map((id) => { const H = HOSTS[id]; return <button key={id} type="button" className="ph-srow" aria-pressed={host === id} onClick={() => pick(id)}>
      <span className="ph-srow-icon"><H.icon size={18} /></span><span className="ph-grow"><strong>{nameOf(id)}</strong><small><i className={`jx-dot ${conn[id]}`} aria-hidden="true" /> {connText(conn[id]).replace(' · messages wait', '')} · {H.bots.filter((n) => usable(id, n)).length} of {H.bots.length} bots ready</small></span>{host === id && <Check size={18} />}
    </button>; })}</div>
    {work && <><div className="ph-section">Folder</div>
      <div className="ph-list">{HOSTS[host].folders.map((f) => <button key={f} type="button" className="ph-srow" aria-pressed={folder === f} onClick={() => setFolder(f)}><span className="ph-srow-icon"><Folder size={18} /></span><span className="ph-grow"><strong>{baseName(f)}</strong><small>{f}</small></span>{folder === f && <Check size={18} />}</button>)}</div></>}
    <div className="ph-section">Bots</div>
    <div className="ph-list">{HOSTS[host].bots.map((n) => {
      const on = crew.includes(n); const tool = toolOf(host, n);
      // A bot that needs sign-in or bubblewrap can't be picked; sign-in sits right on the row.
      if (tool) return <div key={n} className="ph-srow jx-unready">
        <span className="ph-srow-icon"><Avatar seed={PROFILES[n].seed} color={PROFILES[n].color} size="sm" /></span><span className="ph-grow"><strong>{n}</strong><ToolNote state={tool} provider={PROFILES[n].provider} /></span>
        {tool === 'signin' && <button type="button" className="ph-plain" aria-label={`Sign in to ${PROFILES[n].provider} for ${n}`} onClick={() => onSignIn(host, n)}>Sign in</button>}
      </div>;
      return <button key={n} type="button" className="ph-srow" role="checkbox" aria-checked={on} onClick={() => setCrew((c) => (on ? c.filter((x) => x !== n) : [...c, n]))}>
        <span className="ph-srow-icon"><Avatar seed={PROFILES[n].seed} color={PROFILES[n].color} size="sm" /></span><span className="ph-grow"><strong>{n}</strong><small>{settingsLine(member(n))}</small></span>{on && <Check size={18} />}
      </button>; })}</div>
    <p className="ph-sheet-text ph-quiet">{work ? 'Each bot starts on Ask first. Hold its pill in the thread to change that.' : 'Change models, reasoning and speed inside the chat.'}</p>
    <button type="button" className="primary ph-wide jx-done" disabled={!crew.length || (work && !folder)} onClick={() => onStart(host, crew, work ? folder : undefined)}>{crew.length ? `Start with ${crew.join(', ')}` : 'Pick at least one bot'}</button>
  </>;
}

function ToolNote({ state, provider }: { state?: ToolState; provider: Provider }) {
  if (!state) return null;
  return <small className="ph-amber">{state === 'signin' ? `${provider} needs sign-in` : `${provider} can’t chat here: needs bubblewrap (admin)`}</small>;
}

function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <div className="ph-sheet-back" onClick={onClose}>
    <div className="ph-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="ph-handle" />
      <div className="ph-sheet-title"><h3>{title}</h3><button type="button" className="ph-icon" aria-label="Close" onClick={onClose}><X size={20} /></button></div>
      <div className="ph-sheet-body">{children}</div>
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);

// Add a machine: one switch, QR code or Remote SSH. No Mac/Server pick, no id, no address, no token.
// SSH runs silently after one Connect tap: trust the server key on first use, install or update Deck if needed,
// pair this phone, sign out. It only stops for real failures. Chats then use the paired link, never SSH.
type AddStep = 'add' | 'ssh' | 'qr' | 'sshrun';
const ADD_SHEETS: string[] = ['add', 'ssh', 'qr', 'sshrun'];
type SshFail = 'none' | 'plainkey' | 'badkey' | 'passphrase' | 'unreachable' | 'rejected' | 'fingerprint' | 'unsupported' | 'download';
const SSH_FAILS: [SshFail, string][] = [['none', 'Works'], ['plainkey', 'Works, key has no passphrase'], ['badkey', 'Not a usable key'], ['passphrase', 'Wrong passphrase'], ['unreachable', 'Can’t reach host'], ['rejected', 'Server refuses sign-in'], ['fingerprint', 'Fingerprint changed'], ['unsupported', 'No Deck build for this system'], ['download', 'Download fails its check']];
type ServerState = 'fresh' | 'nosudo' | 'current' | 'old' | 'oldbusy';
const SERVER_STATES: [ServerState, string][] = [['fresh', 'No Deck yet'], ['nosudo', 'No Deck, sudo refused'], ['current', 'Deck up to date'], ['old', 'Old Deck, bots idle'], ['oldbusy', 'Old Deck, bots replying']];
const SAMPLE_FP = 'SHA256:q3Vb…sample…T8xE';
/** Admin rights (sudo) come from the typed password. "No admin rights" is a server where sudo refuses it. */
const adminRights = (server: ServerState, password: boolean) => password && server !== 'nosudo';
/** What setup leaves behind: tools that still need sign-in (or bubblewrap), and whether Deck is still waiting to switch. */
function afterSetup(server: ServerState, password: boolean): { updating: boolean; tools: Partial<Record<Provider, ToolState>> } {
  const fresh = server === 'fresh' || server === 'nosudo';
  return { updating: server === 'oldbusy', tools: fresh ? { Claude: 'signin', Codex: adminRights(server, password) ? 'signin' : 'nobwrap' } : {} };
}

/** SSH takes a bare host. Drops a pasted scheme, path or user@, keeps a port from host:port or [v6]:port, and leaves a bare IPv6 address whole.
 * Anything after a single colon is the port, even `abc` or `-1`, so goodPort turns it down instead of it slipping into the host. */
function parseHost(raw: string): { host: string; port?: string } {
  const s = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/^[^@[\]]*@/, '');
  const v6 = /^\[([0-9a-f:.]+)\](?::(.*))?$/i.exec(s);
  if (v6) return { host: v6[1], port: v6[2] };
  const withPort = /^([^:]+):([^:]*)$/.exec(s);
  if (withPort) return { host: withPort[1], port: withPort[2] };
  return { host: s };
}
const goodPort = (p: string) => /^\d+$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;
const hostPort = (host: string, port: string) => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);

type RunLine = { id: string; text: string; failLabel?: string; failText?: string };

/** The silent setup, one line per step. A step that fails carries failText; the run stops there and nothing after it happens. */
function setupLines(o: { fail: SshFail; server: ServerState; where: string; user: string; key: boolean; password: boolean; keep: boolean }): RunLine[] {
  const { fail, server, where, user } = o;
  const sudo = adminRights(server, o.password);
  const fresh = server === 'fresh' || server === 'nosudo';
  return [
    // SSH checks the server's key before any sign-in is sent, so a changed key stops setup with the key, password and passphrase never sent.
    { id: 'reach', text: `Reached ${where}`, failLabel: `Couldn’t reach ${where}`,
      failText: fail === 'unreachable' ? `Can’t reach ${where}. Check the address and that SSH is open. Nothing was sent or changed.` : undefined },
    { id: 'fp', text: `Server key ED25519 ${SAMPLE_FP}, saved on first use`, failLabel: 'Server key changed',
      failText: fail === 'fingerprint' ? `This server’s key changed since this phone last saw it. Someone may be in the middle, so setup stopped before signing in: no key, password or passphrase was sent. If you rebuilt the server, remove it from this phone first, then add it again.` : undefined },
    { id: 'signin', text: `Signed in as ${user}${o.key ? ' with id_ed25519' : ' with password'}`, failLabel: `${where} refused the sign-in`,
      failText: fail === 'rejected' ? (o.key ? `${where} refused this key for ${user}. Add its public key to ~/.ssh/authorized_keys there. Nothing changed on the server.` : `${where} refused the password for ${user}. Many servers turn password sign-in off; use a key instead. Nothing changed on the server.`) : undefined },
    { id: 'system', text: fail === 'unsupported' ? 'Found FreeBSD amd64' : 'Found Linux x86_64',
      failText: fail === 'unsupported' ? 'Deck has no build for FreeBSD amd64 yet. Nothing was installed. Deck runs on Linux (x86_64 or arm64), macOS and Windows.' : undefined },
    { id: 'deck', text: server === 'current' ? 'Deck 0.9.x up to date'
      : server === 'old' ? 'Updated Deck 0.8.2 → 0.9.x (download checked)'
      : server === 'oldbusy' ? 'Deck 0.9.x ready. Switches over when Jigga and Null finish replying'
      : !sudo ? `Installed Deck 0.9.x just for ${user} (no admin rights, download checked)`
      : 'Installed Deck 0.9.x for everyone, starts on boot (download checked)', failLabel: 'Deck 0.9.x download failed its check',
      failText: fail === 'download' && server !== 'current' ? 'Couldn’t download Deck 0.9.x, or the download failed its check. Nothing was installed or changed. Connect again to retry.' : undefined },
    { id: 'bwrap', text: !fresh ? 'bubblewrap already there' : sudo ? 'Installed bubblewrap, so Codex can chat here' : 'Skipped bubblewrap: needs admin rights. Codex can’t chat here until an admin installs it' },
    { id: 'start', text: server === 'current' ? 'Deck running'
      : server === 'old' ? 'Restarted Deck on 0.9.x. No bot was replying'
      : server === 'oldbusy' ? 'Deck 0.8.2 keeps running for now, no reply cut off'
      : !sudo ? `Started Deck for ${user}. Keeps running after sign-out` : 'Started Deck. Starts on boot' },
    { id: 'tools', text: !fresh ? 'AI tools: Claude ready, Codex ready' : sudo ? 'AI tools: installed Claude and Codex. Both need sign-in' : 'AI tools: installed Claude and Codex. Both need sign-in; Codex also needs bubblewrap' },
    { id: 'pair', text: 'Paired this phone and saved it' },
    { id: 'bye', text: o.keep ? 'Signed out. Sign-in kept behind Face ID' : 'Signed out. Key, passphrase and password wiped' },
  ];
}

function AddMachine({ step, fail, server, onStep, onPaired, onDone }: { step: AddStep; fail: SshFail; server: ServerState; onStep(s: AddStep): void; onPaired(id: HostId, label: string, after: { updating: boolean; tools: Partial<Record<Provider, ToolState>> }): void; onDone(): void }) {
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [port, setPort] = useState('22');
  const [key, setKey] = useState(false);
  const [locked, setLocked] = useState(true);
  const [pass, setPass] = useState('');
  const [keep, setKeep] = useState(false);
  const [error, setError] = useState('');
  const [ran, setRan] = useState(0);
  const recorded = useRef(false);
  const sshTab = step === 'ssh';
  const parsed = parseHost(host);
  const bareHost = parsed.host;
  const usePort = parsed.port ?? port;
  const trimmed = bareHost !== host.trim() && bareHost !== '';
  const name = label.trim() || 'Apex-Terminal';
  const lines = setupLines({ fail, server, where: bareHost ? hostPort(bareHost, usePort) : 'server', user: user || 'demo', key, password: password !== '', keep });
  const failAt = lines.findIndex((l) => l.failText);
  // The run never passes a failing step, so a failed setup can never reach the pairing step.
  const stopAt = failAt >= 0 ? failAt : lines.length;
  const pairDone = lines.findIndex((l) => l.id === 'pair') + 1;
  const failed = failAt >= 0 && ran >= failAt;
  useEffect(() => {
    if (step !== 'sshrun') { setRan(0); return; }
    const t = setInterval(() => setRan((n) => Math.min(n + 1, stopAt)), 500);
    return () => clearInterval(t);
  }, [step, stopAt]);
  useEffect(() => {
    // Recorded the moment the server pairs it, not at Done, so closing the sheet or a killed app can't lose it.
    if (step === 'sshrun' && failAt < 0 && ran >= pairDone && !recorded.current) { recorded.current = true; onPaired('linux', label.trim(), afterSetup(server, password !== '')); }
  }, [step, failAt, ran, pairDone, onPaired, label, server, password]);
  const importKey = () => {
    setError('');
    if (fail === 'badkey') { setError('That file isn’t an OpenSSH private key. Pick the private key (id_ed25519), not the .pub file.'); return; }
    setKey(true); setLocked(fail !== 'plainkey');
  };

  if (step === 'qr') return <>
    <p className="ph-sheet-text">Check that <b>Studio MacBook</b> shows this code, then press Approve there.</p>
    <p className="ph-pair-code" aria-label="Code 4 8 2 9 1 3">482913</p>
    <p className="ph-muted">Sample code. If the codes don’t match, press Deny on the machine.</p>
    <button type="button" className="primary ph-wide" onClick={() => { onPaired('mac', '', { updating: false, tools: {} }); onDone(); }}>Approved on the machine (sample)</button>
    <button type="button" className="ph-plain ph-wide" onClick={() => onStep('add')}>Cancel</button>
  </>;

  if (step === 'sshrun') {
    const done = failAt < 0 && ran >= lines.length;
    const status = failed ? lines[failAt].failText
      : done ? (server === 'oldbusy' ? `Done. ${name} switches to Deck 0.9.x by itself once its bots finish; chats there start working then.` : 'Done. Chats use the paired link from now on, not SSH.')
      : ran >= pairDone ? 'Paired and saved. Safe to close now.'
      : `Setting up ${name}… If this stops before pairing, nothing is added to this phone. Connect again and it picks up where it left off, never adding a second copy.`;
    return <>
      <div className="ph-group ph-list">
        {lines.slice(0, Math.min(lines.length, stopAt + 1)).map((l, i) => <div key={l.id} className="ph-srow"><span className="ph-srow-icon">{failed && i === failAt ? <span className="ph-red"><X size={16} /></span> : i < ran ? <Check size={16} /> : <span className="jx-dot reconnecting" />}</span><span className={`ph-grow${failed && i === failAt ? ' ph-red' : ''}`}>{failed && i === failAt ? l.failLabel ?? l.text : l.text}</span></div>)}
      </div>
      <p className={`ph-sheet-text${failed ? ' ph-red' : ' ph-quiet'}`} role={failed ? 'alert' : 'status'}>{status}</p>
      {done && (server === 'fresh' || server === 'nosudo') && <p className="ph-muted">{adminRights(server, password !== '') ? `Claude and Codex show as “Needs sign-in” on ${name}. Tap Sign in on either one in New chat or a bot’s settings, whenever you like; it doesn’t block anything else.` : `Claude shows as “Needs sign-in” on ${name}; tap Sign in in New chat or its settings. Codex can’t chat there until an admin installs bubblewrap.`}</p>}
      {failed ? <button type="button" className="primary ph-wide" onClick={() => onStep('ssh')}>Back</button>
        : <button type="button" className="primary ph-wide" disabled={ran < pairDone} onClick={onDone}>Done</button>}
    </>;
  }

  const connect = () => {
    setError('');
    if (!bareHost || !user.trim()) { setError('Fill in the host and user.'); return; }
    if (!goodPort(usePort)) { setError(`Port ${usePort || '(blank)'} won’t work. Use a number from 1 to 65535.`); return; }
    if (!key && !password) { setError('Import a private key or type a password.'); return; }
    if (key && locked && !pass) { setError('This key is locked with a passphrase. Type it to unlock the key.'); return; }
    // Checked on the phone before anything goes out.
    if (fail === 'passphrase') { setError('Wrong passphrase for id_ed25519. Nothing was sent.'); return; }
    recorded.current = false;
    onStep('sshrun');
  };

  return <>
    <div className="ph-segment" role="radiogroup" aria-label="How to add it">
      <button type="button" role="radio" aria-checked={!sshTab} onClick={() => onStep('add')}><Camera size={16} />QR code</button>
      <button type="button" role="radio" aria-checked={sshTab} onClick={() => onStep('ssh')}><Terminal size={16} />Remote SSH</button>
    </div>
    {!sshTab ? <>
      <p className="ph-sheet-text">On the machine, open Settings → Phones → Pair phone. On a server, run <code>apex-daemon pair</code>. The name comes from the code.</p>
      <button type="button" className="primary ph-wide jx-scan" onClick={() => onStep('qr')}><Camera size={16} /> Scan QR code</button>
      <label className="ph-label">Or paste the pairing link<input placeholder="apexdeck://pair?p=…" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
      <button type="button" className="ph-wide" onClick={() => onStep('qr')}>Pair with link</button>
    </> : <form className="ph-form" onSubmit={(e) => { e.preventDefault(); connect(); }}>
      <p className="ph-sheet-text">For a server you can SSH into. Tap Connect and the phone does the rest: installs or updates Deck if needed, pairs, then signs out. Chats use the paired link, not SSH.</p>
      <label className="ph-label">Label (optional)<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My Remote VPS" /><small>Shown in Chats. Blank uses the machine’s own name.</small></label>
      <label className="ph-label">IP or host<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="203.0.113.10 or server.example.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" />{trimmed && <small>SSH uses the bare host, so this connects to <b>{bareHost}</b>{parsed.port !== undefined && goodPort(parsed.port) ? <> on port <b>{parsed.port}</b></> : null}.</small>}</label>
      <div className="jx-row2">
        <label className="ph-label">User<input value={user} onChange={(e) => setUser(e.target.value)} placeholder="demo" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
        <label className="ph-label jx-port">Port<input value={usePort} disabled={parsed.port !== undefined} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} inputMode="numeric" aria-describedby={parsed.port !== undefined ? 'jx-port-from-host' : undefined} />{parsed.port !== undefined && <small id="jx-port-from-host">From the address</small>}</label>
      </div>
      <label className="ph-label">Password (optional)<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" /><small>For password sign-in, and for admin rights (sudo). Without it, Deck installs just for this user and Codex can’t chat there (it needs bubblewrap, which needs sudo). A key is safer for signing in.</small></label>
      <span className="ph-label">Private key</span>
      {key ? <div className="ph-group ph-srow"><span className="ph-srow-icon">{locked ? <Lock size={16} /> : <Check size={16} />}</span><span className="ph-grow"><strong>id_ed25519</strong><small>OpenSSH · ed25519 · {locked ? 'locked with a passphrase' : 'no passphrase'}</small></span><button type="button" className="ph-plain" onClick={() => { setKey(false); setPass(''); }}>Remove</button></div>
        : <><button type="button" className="ph-wide" onClick={importKey}>Import private key from Files (sample)</button><small className="ph-muted">The phone can’t see your computer’s ~/.ssh. AirDrop or save the key (id_ed25519) into Files first.</small></>}
      {key && locked && <label className="ph-label">Private key passphrase<input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" /><small>This key is locked, so the passphrase is needed. Keys without one skip this box. Unlocks the key on this phone only; never sent to the server.</small></label>}
      {(key || password) && <>
        <span className="ph-label">After setup</span>
        <div className="ph-segment" role="radiogroup" aria-label="After setup">
          <button type="button" role="radio" aria-checked={!keep} onClick={() => setKeep(false)}>Forget sign-in</button>
          <button type="button" role="radio" aria-checked={keep} onClick={() => setKeep(true)}>Keep with Face ID</button>
        </div>
        <p className="ph-muted">{keep ? 'Key, passphrase and password stay in this phone’s Keychain and open only with Face ID. Use them to repair the pairing later.' : 'Deck’s imported copy of the key, the passphrase and the password are wiped from this phone once setup ends. Nothing is saved. Your original key file in Files is not touched.'}</p>
      </>}
      {error && <p className="ph-sheet-text ph-red" role="alert">{error}</p>}
      <button type="submit" className="primary ph-wide">Connect</button>
    </form>}
  </>;
}
