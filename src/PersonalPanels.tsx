import { useEffect, useState } from 'react';
import { PersonalBrowser } from './PersonalBrowser.tsx';
import { CLASS_LABEL, MODE_LABEL, TASK_STATUS, type ActionMode, type ConnectorState, type CostEntry, type PersonalAssistantRecord, type PersonalLane, type PersonalSettings, type PersonalTask, type ToolClass } from './personalAssistant.ts';

export type PanelName = 'activity' | 'scheduled' | 'memory' | 'rules' | 'settings' | 'costs' | 'notices' | 'connections';

const TABS: { id: PanelName; label: string }[] = [
  { id: 'activity', label: 'Activity' }, { id: 'scheduled', label: 'Scheduled' }, { id: 'memory', label: 'Memory' },
  { id: 'rules', label: 'Rules' }, { id: 'settings', label: 'Settings' }, { id: 'costs', label: 'Costs' }, { id: 'notices', label: 'Notices' }, { id: 'connections', label: 'Connections' },
];
const CLASSES: ToolClass[] = ['read', 'write', 'send', 'spend'];
const MODES: ActionMode[] = ['auto', 'onRequest', 'ask', 'handOff'];
const DEFAULT_MODES: Record<ToolClass, ActionMode> = { read: 'auto', write: 'ask', send: 'ask', spend: 'ask' };
const SPEND_NOTE = "Spending can't run without asking unless you set a budget";
const DAY = 24 * 60 * 60 * 1000;
const ACTIVE: PersonalTask['status'][] = ['queued', 'running', 'waiting', 'blocked'];
const SETTLED: PersonalTask['status'][] = ['done', 'failed', 'cancelled'];

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ts: number) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayOf = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const usd = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;
const roughUsd = (micros: number) => `est. $${(micros / 1e6).toFixed(2)}`;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const replies = (n: number) => `${n} ${n === 1 ? 'reply' : 'replies'}`;

function waitText(wait: PersonalTask['wait']) {
  if (!wait) return '';
  if (wait.kind === 'timer') return `Next run at ${clock(wait.at)}`;
  if (wait.kind === 'dependency') return `After task ${wait.taskId}`;
  return `Waiting for ${wait.hostId} to connect`;
}

function costOf(entry: CostEntry) {
  if (entry.source === 'reported') return usd(entry.micros ?? 0);
  if (entry.source === 'estimated') return roughUsd(entry.micros ?? 0);
  return 'unknown';
}

/** Unknown-cost replies are counted, never added as $0. */
function totals(costs: CostEntry[], since: number) {
  let reported = 0, estimated = 0, unknown = 0, bytes = 0;
  for (const entry of costs) {
    if (entry.at < since) continue;
    bytes += entry.bytesOut ?? 0;
    if (entry.source === 'reported') reported += entry.micros ?? 0;
    else if (entry.source === 'estimated') estimated += entry.micros ?? 0;
    else unknown += 1;
  }
  return { reported, estimated, unknown, bytes };
}

type Draft = {
  name: string; style: string; timezone: string; quietStart: string; quietEnd: string; dailyDollars: string;
  unknownCostOk: boolean; localOnly: boolean; endpoints: string; contextChars: string;
};

function draftOf(a: PersonalAssistantRecord): Draft {
  return {
    name: a.name ?? '', style: a.style ?? '', timezone: a.timezone ?? '',
    quietStart: a.quietHours?.start ?? '', quietEnd: a.quietHours?.end ?? '',
    dailyDollars: a.budget?.dailyLimitMicros != null ? String(a.budget.dailyLimitMicros / 1e6) : '',
    unknownCostOk: !!a.budget?.unknownCostOk, localOnly: !!a.privacy?.localOnly,
    endpoints: (a.privacy?.allowedEndpoints ?? []).join('\n'), contextChars: String(a.contextBudgetChars ?? ''),
  };
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/** Only the fields the user changed are sent. */
function settingsPatch(a: PersonalAssistantRecord, d: Draft): Partial<PersonalSettings> {
  const base = draftOf(a);
  const patch: Partial<PersonalSettings> = {};
  if (d.name !== base.name) patch.name = d.name.trim();
  if (d.style !== base.style) patch.style = d.style;
  if (d.timezone !== base.timezone) patch.timezone = d.timezone.trim();
  if (d.quietStart !== base.quietStart || d.quietEnd !== base.quietEnd) {
    patch.quietHours = d.quietStart && d.quietEnd ? { start: d.quietStart, end: d.quietEnd } : undefined;
  }
  if (d.dailyDollars !== base.dailyDollars || d.unknownCostOk !== base.unknownCostOk) {
    const dollars = d.dailyDollars.trim() === '' ? undefined : Number(d.dailyDollars);
    if (dollars !== undefined && (!Number.isFinite(dollars) || dollars < 0)) throw new Error('Enter a daily limit in dollars, or leave it empty for none.');
    patch.budget = { ...(a.budget ?? {}), dailyLimitMicros: dollars === undefined ? undefined : Math.round(dollars * 1e6), unknownCostOk: d.unknownCostOk };
  }
  if (d.localOnly !== base.localOnly || d.endpoints !== base.endpoints) {
    patch.privacy = { ...(a.privacy ?? { localOnly: false, allowedEndpoints: [] }), localOnly: d.localOnly, allowedEndpoints: lines(d.endpoints) };
  }
  if (d.contextChars !== base.contextChars) {
    const chars = Number(d.contextChars);
    if (!Number.isInteger(chars) || chars <= 0) throw new Error('Context budget must be a whole number of characters.');
    patch.contextBudgetChars = chars;
  }
  return patch;
}

/** One panel for the personal assistant: tabs on top, one scrollable view below. */
export function PersonalPanels({ lane, initial = 'activity', onClose }: { lane: PersonalLane; initial?: PanelName; onClose: () => void }) {
  const [panel, setPanel] = useState<PanelName>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [memoryText, setMemoryText] = useState('');
  const [rule, setRule] = useState<{ text: string; cls: ToolClass; mode: ActionMode }>({ text: '', cls: 'write', mode: 'ask' });
  const [draft, setDraft] = useState<{ rev: number; value: Draft } | null>(null);
  const [connectors, setConnectors] = useState<ConnectorState[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [folder, setFolder] = useState('~/apex-assistant');
  const [githubToken, setGithubToken] = useState('');
  const [google, setGoogle] = useState({ clientId: '', clientSecret: '' });
  const reloadConnectors = async () => { if (lane.connectors) setConnectors(await lane.connectors()); };
  useEffect(() => {
    if (panel !== 'connections' || !lane.connectors) return;
    lane.connectors().then(setConnectors).catch(() => undefined);
  }, [panel]);

  const a = lane.assistant;
  const locked = busy || lane.offline;
  const now = Date.now();

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const current = a ? (draft && draft.rev === a.revision ? draft.value : draftOf(a)) : null;
  const edit = (patch: Partial<Draft>) => { if (a && current) setDraft({ rev: a.revision, value: { ...current, ...patch } }); };

  const waitingRow = (task: PersonalTask) => {
    const expanded = openTask === task.id;
    const receipt = task.receipts[task.receipts.length - 1];
    const unsettled = !SETTLED.includes(task.status);
    const wait = waitText(task.wait);
    return (
      <div className="personal-panels-row" key={task.id}>
        <button type="button" className="personal-panels-rowmain" aria-expanded={expanded} onClick={() => setOpenTask(expanded ? null : task.id)}>
          <span className="personal-panels-goal">{task.goal}</span>
          <span className="personal-panels-chip" data-status={task.status}>{TASK_STATUS[task.status]}</span>
          {task.kind === 'helper' && <span className="personal-panels-muted">helper</span>}
          {!!task.runsDone && <span className="personal-panels-muted">{task.runsDone === 1 ? '1 run' : `${task.runsDone} runs`}</span>}
        </button>
        <div className="personal-panels-muted">
          {task.lastUpdate ?? when(task.updatedAt)}
          {wait && <span> · {wait}</span>}
        </div>
        {unsettled && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.cancel(task.id))}>Stop task</button></div>}
        {expanded && <pre>{receipt?.outputExcerpt.trim() ? receipt.outputExcerpt : receipt?.finishedAt ? 'It printed nothing.' : 'No output yet.'}</pre>}
      </div>
    );
  };

  const activityView = (rec: PersonalAssistantRecord) => {
    const tasks = [...(rec.tasks ?? [])].sort((x, y) => y.updatedAt - x.updatedAt);
    const groups: [string, PersonalTask[]][] = [
      ['Needs you', tasks.filter((task) => task.status === 'needsYou')],
      ['In progress', tasks.filter((task) => ACTIVE.includes(task.status))],
      ['Finished', tasks.filter((task) => SETTLED.includes(task.status)).slice(0, 20)],
    ];
    if (!tasks.length) return <p className="personal-panels-muted">No tasks yet.</p>;
    return groups.filter(([, list]) => list.length).map(([title, list]) => (
      <section key={title}><h4>{title}</h4>{list.map(waitingRow)}</section>
    ));
  };

  const scheduledView = (rec: PersonalAssistantRecord) => {
    const schedules = (rec.schedules ?? []).filter((item) => item.status !== 'cancelled');
    if (!schedules.length) return <p className="personal-panels-muted">Nothing scheduled. Ask the assistant to do something every day or at a set time.</p>;
    return schedules.map((item) => {
      const cadence = item.everyMs ? `Every ${Math.round(item.everyMs / 60000)} min` : item.dailyAt ? `Daily at ${item.dailyAt}` : 'Scheduled';
      return (
        <div className="personal-panels-row" key={item.id}>
          <div className="personal-panels-rowmain"><span className="personal-panels-goal">{item.goal}</span><span className="personal-panels-muted">{cadence}</span></div>
          <div className="personal-panels-muted">{item.status === 'proposed' ? 'Waiting for you to confirm it in the conversation' : item.nextAt ? `Next run ${when(item.nextAt)}` : 'No next run set'}</div>
          {lane.cancelSchedule && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.cancelSchedule!(item.id))}>Cancel schedule</button></div>}
        </div>
      );
    });
  };

  const memoryView = (rec: PersonalAssistantRecord) => {
    const facts = rec.facts ?? [];
    const live = facts.filter((fact) => !fact.deletedAt && !fact.supersededBy && !(fact.expiresAt && fact.expiresAt <= now));
    const older = facts.filter((fact) => !fact.deletedAt && fact.supersededBy);
    return (
      <>
        {lane.remember && (
          <form className="personal-panels-inline" onSubmit={(event) => {
            event.preventDefault();
            const text = memoryText.trim();
            if (!text) return;
            void run(async () => { await lane.remember!(text); setMemoryText(''); });
          }}>
            <input aria-label="Something to remember" value={memoryText} onChange={(event) => setMemoryText(event.target.value)} placeholder="Something to remember" />
            <button type="submit" disabled={locked || !memoryText.trim()}>Remember</button>
          </form>
        )}
        {!live.length && <p className="personal-panels-muted">Nothing remembered yet.</p>}
        {live.map((fact) => (
          <div className="personal-panels-row" key={fact.id}>
            {editing?.id === fact.id ? (
              <div className="personal-panels-inline">
                <input aria-label="Corrected fact" value={editing.text} onChange={(event) => setEditing({ id: fact.id, text: event.target.value })} />
                <button type="button" disabled={locked || !editing.text.trim()} onClick={() => void run(async () => { await lane.correctFact!(fact.id, editing.text.trim()); setEditing(null); })}>Save</button>
                <button type="button" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            ) : (
              <div className="personal-panels-rowmain"><span className="personal-panels-goal">{fact.text}</span></div>
            )}
            <div className="personal-panels-muted">
              {fact.kind} · {fact.explicit ? 'You said' : 'Inferred'}{!fact.explicit && ` · ${fact.confidence}%`} · {dayOf(fact.createdAt)}
            </div>
            {editing?.id !== fact.id && (
              <div className="personal-panels-actions">
                {lane.correctFact && <button type="button" disabled={locked} onClick={() => setEditing({ id: fact.id, text: fact.text })}>Correct</button>}
                {lane.forgetFact && <button type="button" disabled={locked} onClick={() => {
                  if (typeof window !== 'undefined' && !window.confirm('Forget this?')) return;
                  void run(() => lane.forgetFact!(fact.id));
                }}>Forget</button>}
              </div>
            )}
          </div>
        ))}
        {!!older.length && (
          <details>
            <summary>Older versions</summary>
            <ul>{older.map((fact) => <li key={fact.id} className="personal-panels-muted personal-panels-struck">{fact.text}</li>)}</ul>
          </details>
        )}
      </>
    );
  };

  const rulesView = (rec: PersonalAssistantRecord) => {
    const modes = rec.modes ?? DEFAULT_MODES;
    const rules = rec.rules ?? [];
    return (
      <>
        {CLASSES.map((cls) => (
          <div className="personal-panels-row" key={cls}>
            <div className="personal-panels-rowmain">
              <span className="personal-panels-goal">{CLASS_LABEL[cls]}</span>
              {lane.configure ? (
                <select aria-label={CLASS_LABEL[cls]} value={modes[cls]} disabled={locked} onChange={(event) => {
                  const mode = event.target.value as ActionMode;
                  void run(() => lane.configure!({ modes: { ...modes, [cls]: mode } }));
                }}>
                  {MODES.map((mode) => {
                    const blocked = cls === 'spend' && mode === 'auto';
                    return <option key={mode} value={mode} disabled={blocked} title={blocked ? SPEND_NOTE : undefined}>{MODE_LABEL[mode]}</option>;
                  })}
                </select>
              ) : <span className="personal-panels-muted">{MODE_LABEL[modes[cls]]}</span>}
            </div>
          </div>
        ))}
        <h4>Standing rules</h4>
        {!rules.length && <p className="personal-panels-muted">No standing rules yet.</p>}
        {rules.map((item) => (
          <div className="personal-panels-row" key={item.id}>
            <div className="personal-panels-rowmain"><span className="personal-panels-goal">{item.text}</span></div>
            <div className="personal-panels-muted">{CLASS_LABEL[item.class]} · {MODE_LABEL[item.mode]}</div>
            {lane.removeRule && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.removeRule!(item.id))}>Remove</button></div>}
          </div>
        ))}
        {lane.addRule && (
          <form className="personal-panels-form" onSubmit={(event) => {
            event.preventDefault();
            const text = rule.text.trim();
            if (!text) return;
            void run(async () => { await lane.addRule!(text, rule.cls, rule.mode); setRule((prev) => ({ ...prev, text: '' })); });
          }}>
            <input aria-label="Rule text" value={rule.text} placeholder="e.g. Ask before emailing clients" onChange={(event) => setRule((prev) => ({ ...prev, text: event.target.value }))} />
            <div className="personal-panels-inline">
              <select aria-label="Rule class" value={rule.cls} onChange={(event) => setRule((prev) => ({ ...prev, cls: event.target.value as ToolClass }))}>
                {CLASSES.map((cls) => <option key={cls} value={cls}>{CLASS_LABEL[cls]}</option>)}
              </select>
              <select aria-label="Rule mode" value={rule.mode} onChange={(event) => setRule((prev) => ({ ...prev, mode: event.target.value as ActionMode }))}>
                {(['ask', 'handOff'] as ActionMode[]).map((mode) => <option key={mode} value={mode}>{MODE_LABEL[mode]}</option>)}
              </select>
            </div>
            <p className="personal-panels-muted">Rules can only make it more careful.</p>
            <div><button type="submit" disabled={locked || !rule.text.trim()}>Add rule</button></div>
          </form>
        )}
      </>
    );
  };

  const settingsView = (rec: PersonalAssistantRecord, d: Draft) => {
    const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(rec));
    return (
      <form className="personal-panels-form" onSubmit={(event) => {
        event.preventDefault();
        if (!lane.configure || !dirty) return;
        void run(async () => { await lane.configure!(settingsPatch(rec, d)); setDraft(null); });
      }}>
        <label className="personal-panels-field">Name<input value={d.name} onChange={(event) => edit({ name: event.target.value })} /></label>
        <label className="personal-panels-field">Style<textarea rows={3} value={d.style} onChange={(event) => edit({ style: event.target.value })} /></label>
        <label className="personal-panels-field">Timezone<input value={d.timezone} placeholder="Europe/London" onChange={(event) => edit({ timezone: event.target.value })} /></label>
        <div className="personal-panels-inline">
          <label className="personal-panels-field">Quiet hours start<input type="time" value={d.quietStart} onChange={(event) => edit({ quietStart: event.target.value })} /></label>
          <label className="personal-panels-field">Quiet hours end<input type="time" value={d.quietEnd} onChange={(event) => edit({ quietEnd: event.target.value })} /></label>
        </div>
        <label className="personal-panels-field">Daily spend limit (dollars, empty for none)<input type="number" min="0" step="0.01" value={d.dailyDollars} onChange={(event) => edit({ dailyDollars: event.target.value })} /></label>
        <label><input type="checkbox" checked={d.unknownCostOk} onChange={(event) => edit({ unknownCostOk: event.target.checked })} /> Allow replies whose cost isn't reported</label>
        <label><input type="checkbox" checked={d.localOnly} onChange={(event) => edit({ localOnly: event.target.checked })} /> Local only (no cloud model or network tools)</label>
        <label className="personal-panels-field">Allowed model endpoints (one per line)<textarea rows={3} value={d.endpoints} onChange={(event) => edit({ endpoints: event.target.value })} /></label>
        <label className="personal-panels-field">Context budget (characters)<input type="number" min="1" step="1" value={d.contextChars} onChange={(event) => edit({ contextChars: event.target.value })} /></label>
        <p className="personal-panels-muted">Your conversation is stored on {lane.hostName}, but each reply sends its context to the model's provider.</p>
        <div><button type="submit" className="primary" disabled={locked || !dirty || !lane.configure}>Save</button></div>
      </form>
    );
  };

  const costsView = (rec: PersonalAssistantRecord) => {
    const costs = rec.costs ?? [];
    const windows: [string, number][] = [['Today', new Date(now).setHours(0, 0, 0, 0)], ['Last 7 days', now - 7 * DAY]];
    const newest = [...costs].sort((x, y) => y.at - x.at).slice(0, 30);
    return (
      <>
        {windows.map(([label, since]) => {
          const sum = totals(costs, since);
          return (
            <p key={label}>
              <strong>{label}</strong>: {usd(sum.reported)} · {roughUsd(sum.estimated)} · {sum.unknown > 0 ? `${replies(sum.unknown)} with unknown cost` : 'no unknown costs'} · Sent to model providers: {kb(sum.bytes)}
            </p>
          );
        })}
        {!costs.length && <p className="personal-panels-muted">No model calls yet.</p>}
        {!!newest.length && (
          <table>
            <thead><tr><th>Time</th><th>Purpose</th><th>Kind</th><th>Endpoint</th><th>Cost</th></tr></thead>
            <tbody>
              {newest.map((entry, index) => (
                <tr key={`${entry.at}-${index}`}>
                  <td>{when(entry.at)}</td><td>{entry.purpose}</td><td>{entry.kind}</td><td>{entry.endpoint}</td><td>{costOf(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  };

  const noticesView = (rec: PersonalAssistantRecord) => {
    const notices = [...(rec.notices ?? [])].sort((x, y) => y.at - x.at);
    const unseen = notices.filter((item) => !item.seenAt).length;
    if (!notices.length) return <p className="personal-panels-muted">No notices.</p>;
    return (
      <>
        {!!unseen && lane.seeNotices && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.seeNotices!())}>Mark all seen</button></div>}
        {notices.map((item) => {
          const pending = item.deliveredAt == null;
          const status = pending ? (item.urgent ? 'Held for quiet hours' : 'In next digest') : `Delivered ${when(item.deliveredAt!)}`;
          return (
            <div className="personal-panels-row" key={item.id}>
              <div className="personal-panels-rowmain">{item.seenAt ? <span className="personal-panels-goal">{item.text}</span> : <strong className="personal-panels-goal personal-panels-unseen">{item.text}</strong>}</div>
              <div className="personal-panels-muted">{when(item.at)} · {status}{pending && item.deliverAt > now ? ` · ${when(item.deliverAt)}` : ''}</div>
            </div>
          );
        })}
      </>
    );
  };

  const connectionsView = (rec: PersonalAssistantRecord) => {
    const machines = rec.machines ?? [];
    const mine = machines.find((machine) => machine.hostId === lane.localHostId);
    const others = machines.filter((machine) => machine.hostId !== lane.localHostId);
    const github = connectors.find((item) => item.kind === 'github');
    const googleOn = connectors.some((item) => (item.kind === 'gmail' || item.kind === 'drive') && item.connected);
    const browser = connectors.find((item) => item.kind === 'browser');
    const signIn = typeof window === 'undefined' ? undefined : (window as unknown as { apexDeck?: { googleSignIn?: (args: { clientId: string; clientSecret: string }) => Promise<{ refreshToken: string }> } }).apexDeck?.googleSignIn;
    const GOOGLE_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
    return (
      <>
        <h4>This Mac</h4>
        <p className="personal-panels-muted">{mine ? `Linked. Folder: ${mine.folder}` : 'Not linked.'}</p>
        {!mine && lane.linkThisMac && (
          <form className="personal-panels-inline" onSubmit={(event) => {
            event.preventDefault();
            const value = folder.trim();
            if (value) void run(() => lane.linkThisMac!(value));
          }}>
            <input aria-label="Folder on this Mac" value={folder} onChange={(event) => setFolder(event.target.value)} />
            <button type="submit" disabled={locked || !folder.trim()}>Let assistant use this Mac</button>
          </form>
        )}
        {mine && lane.unlinkMachine && lane.localHostId && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.unlinkMachine!(lane.localHostId!))}>Stop using this Mac</button></div>}
        <p className="personal-panels-muted">Commands for this Mac run only while Deck is open here. Nothing moves to another machine.</p>
        {others.map((machine) => (
          <div className="personal-panels-row" key={machine.hostId}>
            <div className="personal-panels-rowmain"><span className="personal-panels-goal">{machine.name}</span></div>
            <div className="personal-panels-muted">{machine.folder}</div>
            {lane.unlinkMachine && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.unlinkMachine!(machine.hostId))}>Remove</button></div>}
          </div>
        ))}

        <h4>GitHub</h4>
        <p className="personal-panels-muted">{github?.connected ? 'Connected.' : 'Not connected.'} Use a fine-grained token with read-only access.</p>
        {lane.saveKey && (
          <form className="personal-panels-inline" onSubmit={(event) => {
            event.preventDefault();
            const value = githubToken.trim();
            if (!value) return;
            void run(async () => { await lane.saveKey!('GITHUB_TOKEN', value); setGithubToken(''); await reloadConnectors(); });
          }}>
            <input type="password" aria-label="GitHub token" placeholder="Personal access token" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} />
            <button type="submit" disabled={locked || !githubToken.trim()}>Save</button>
            {github?.connected && lane.removeKey && <button type="button" disabled={locked} onClick={() => void run(async () => { await lane.removeKey!('GITHUB_TOKEN'); await reloadConnectors(); })}>Disconnect</button>}
          </form>
        )}

        <h4>Google (Gmail and Drive)</h4>
        <p className="personal-panels-muted">{googleOn ? 'Connected.' : 'Not connected.'} Read-only: Gmail and Drive are only searched and read, never changed or sent.</p>
        {lane.saveKey && (
          <form className="personal-panels-form" onSubmit={(event) => event.preventDefault()}>
            <input aria-label="OAuth client ID" placeholder="Client ID (Desktop app type)" value={google.clientId} onChange={(event) => setGoogle({ ...google, clientId: event.target.value })} />
            <input type="password" aria-label="OAuth client secret" placeholder="Client secret" value={google.clientSecret} onChange={(event) => setGoogle({ ...google, clientSecret: event.target.value })} />
            <div className="personal-panels-inline">
              {signIn && (
                <button type="button" className="primary" disabled={locked || !google.clientId.trim() || !google.clientSecret.trim()} onClick={() => void run(async () => {
                  const { refreshToken } = await signIn({ clientId: google.clientId.trim(), clientSecret: google.clientSecret.trim() });
                  await lane.saveKey!('GOOGLE_CLIENT_ID', google.clientId.trim());
                  await lane.saveKey!('GOOGLE_CLIENT_SECRET', google.clientSecret.trim());
                  await lane.saveKey!('GOOGLE_REFRESH_TOKEN', refreshToken);
                  setGoogle({ clientId: '', clientSecret: '' });
                  await reloadConnectors();
                })}>Sign in with Google</button>
              )}
              {googleOn && lane.removeKey && <button type="button" disabled={locked} onClick={() => void run(async () => { for (const key of GOOGLE_KEYS) await lane.removeKey!(key); await reloadConnectors(); })}>Disconnect</button>}
            </div>
          </form>
        )}

        <h4>Browser</h4>
        <p className="personal-panels-muted">{browser?.connected ? 'Available.' : 'Not available.'} The assistant can open pages; you can take over to click and sign in.</p>
        {lane.browserView && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => setBrowserOpen(true)}>Open browser / Take over</button></div>}
      </>
    );
  };

  const content = () => {
    if (!a) {
      if (lane.problem) return <p className="personal-panels-muted">{lane.problem}</p>;
      return (
        <>
          <p className="personal-panels-muted">No assistant yet.</p>
          {lane.setUp && <div className="personal-panels-actions"><button type="button" className="primary" disabled={locked} onClick={() => void run(() => lane.setUp!())}>Set up assistant</button></div>}
        </>
      );
    }
    switch (panel) {
      case 'activity': return activityView(a);
      case 'scheduled': return scheduledView(a);
      case 'memory': return memoryView(a);
      case 'rules': return rulesView(a);
      case 'settings': return current ? settingsView(a, current) : null;
      case 'costs': return costsView(a);
      case 'notices': return noticesView(a);
      case 'connections': return connectionsView(a);
    }
  };

  return (
    <div className="personal-panels">
      <div className="personal-panels-head">
        <strong>{lane.name}</strong>
        <span className="personal-panels-muted">{lane.hostName}</span>
        <button type="button" className="personal-panels-close" onClick={onClose}>Close</button>
      </div>
      <div className="personal-panels-tabs" role="tablist" aria-label="Assistant panels">
        {TABS.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={panel === tab.id} onClick={() => setPanel(tab.id)}>{tab.label}</button>
        ))}
      </div>
      {lane.offline && <p className="personal-panels-muted">Offline. Changes are paused until it reconnects.</p>}
      {error && <p role="alert" className="personal-panels-alert">{error}</p>}
      <div className="personal-panels-body">{content()}</div>
      {browserOpen && lane.browserView && <PersonalBrowser lane={lane} onClose={() => setBrowserOpen(false)} />}
    </div>
  );
}
