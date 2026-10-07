import { popoverTop } from './floating';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Backend } from './backend';
import type { ModelChoice, ParticipantConfig } from './types';
import { AGENT_EFFORTS, API_EFFORTS, effortsFor, findModel, modelGroups } from './models';
import { Picker } from './Picker';
import { ReasoningSlider } from './ReasoningSlider';
import { latestSaveQueue } from './settingsSave';
import { applyTurnChange } from './participantSettings';

interface Props {
  config: ParticipantConfig;
  roomId: string;
  anchor: HTMLElement;
  backend: Backend;
  save: (config: ParticipantConfig, base: ParticipantConfig) => Promise<void>;
  close: () => void;
  /** The bot's avatar, shown beside its name. */
  avatar?: ReactNode;
  /** Context and plan bars, shown under the name. */
  meters?: ReactNode;
}
export function BotSettings({ config, roomId, anchor, backend, save, close, avatar, meters }: Props) {
  const tool = config.backend.kind === 'agent' ? config.backend.tool : null;
  const [reported, setReported] = useState<ModelChoice[]>([]);
  const [model, setModel] = useState('model' in config.backend ? config.backend.model ?? '' : '');
  const [effort, setEffort] = useState(config.effort ?? '');
  const [autoAvailable, setAutoAvailable] = useState(false);
  useEffect(() => { if (tool !== 'codex' && tool !== 'claude_code') return; let active = true; backend.decisionKeyStatus().then(ok => { if (active) setAutoAvailable(ok); }).catch(() => {}); return () => { active = false; }; }, [backend, tool]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const saveRef = useRef(save);
  saveRef.current = save;
  const orderedSave = useRef(latestSaveQueue<{ change: { model?: string; effort?: string; auto_effort?: boolean }; base: ParticipantConfig }>(async value => {
    const state = await backend.roomCreate(roomId, [], { policy: 'mention', max_bot_hops: 0 }, '');
    const current = state.participants.find(p => p.id === value.base.id);
    if (!current) throw new Error('This bot is no longer in the thread.');
    await saveRef.current(applyTurnChange(current, value.change), current);
  }));
  const touched = useRef<{ model?: string; effort?: string; auto_effort?: boolean }>({});
  const [settled, setSettled] = useState(0);
  const savedModel = "model" in config.backend ? config.backend.model ?? "" : "";
  const savedEffort = config.effort ?? "";
  useEffect(() => {
    if (!("model" in touched.current)) { setModel(savedModel); requested.current.model = savedModel; }
    if (!("effort" in touched.current)) { setEffort(savedEffort); requested.current.effort = savedEffort; }
  }, [savedModel, savedEffort, settled]);
  const saveVersion = useRef(0);
  const requested = useRef({ model, effort });
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = root.current?.offsetHeight ?? 260;
    setPosition({ top: popoverTop(rect, height, window.innerHeight), left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)) });
    root.current?.querySelector<HTMLElement>('[aria-checked="true"], input, select')?.focus();
  }, [anchor]);
  useEffect(() => {
    let active = true;
    if (tool) backend.agentModels(tool).then(list => { if (active) setReported(list); }).catch(() => {});
    return () => { active = false; };
  }, [backend, tool]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (root.current?.querySelector('.model-select .model-menu')) { event.stopPropagation(); setOpen(false); return; } event.stopPropagation(); close(); anchor.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', close); };
  }, [anchor, close]);
  const groups = tool ? modelGroups(tool, reported, tool === 'codex' ? 'Codex' : tool === 'claude_code' ? 'Claude Code' : tool === 'grok' ? 'Grok' : 'Gemini') : [];
  const efforts = tool ? effortsFor(AGENT_EFFORTS[tool], groups, model) : API_EFFORTS;
  const supportedEffort = efforts.includes(effort) ? effort : '';
  const note = findModel(groups, model)?.note;
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0, maxHeight: 260 });
  const all = groups.flatMap(g => g.models);
  const shown = all.slice(0, 4);
  const extra = all.slice(4);
  const current = all.find(m => m.id === model);
  const pickModel = (id: string) => { setModel(id); setOpen(false); setMore(false); void apply({ model: id }); };
  /** Saves right away; there is no Apply step for agent bots. */
  const apply = async (change: { model?: string; effort?: string; auto_effort?: boolean }) => {
    const sent = { ...touched.current, ...change };
    const nextModel = sent.model ?? savedModel;
    const nextEffort = sent.effort ?? savedEffort;
    const nextEfforts = tool ? effortsFor(AGENT_EFFORTS[tool], groups, nextModel) : API_EFFORTS;
    const normalizedEffort = nextEfforts.includes(nextEffort) ? nextEffort : '';
    // A model with no reasoning support explicitly clears the old level.
    if ('model' in sent && normalizedEffort !== nextEffort) sent.effort = normalizedEffort;
    if (!nextEfforts.length) sent.auto_effort = false;
    touched.current = sent;
    requested.current = { model: nextModel, effort: normalizedEffort };
    const version = ++saveVersion.current;
    setSaving(true); setError('');
    try {
      await orderedSave.current({ change: sent, base: config });
      const left = { ...touched.current };
      if (left.model === sent.model) delete left.model;
      if (left.effort === sent.effort) delete left.effort;
      if (left.auto_effort === sent.auto_effort) delete left.auto_effort;
      touched.current = left;
      setSettled(n => n + 1);
    }
    catch (error) { if (version === saveVersion.current) { setError(String(error)); requested.current = { model: '\0', effort: '\0' }; } }
    if (version === saveVersion.current) setSaving(false);
  };
  useEffect(() => {
    const pick = (event: KeyboardEvent) => { const n = Number(event.key); if (!tool || !open || saving || !(n >= 1 && n <= shown.length + 1) || (event.target as HTMLElement).tagName === 'INPUT') return; pickModel(n === 1 ? '' : shown[n - 2].id); };
    document.addEventListener('keydown', pick);
    return () => document.removeEventListener('keydown', pick);
  });
  const commitEffort = (value: string) => {
    setEffort(value);
    if (value !== requested.current.effort || model !== requested.current.model) void apply({ effort: value });
  };
  return createPortal(<div ref={root} className="bot-settings" style={position} onScroll={() => setOpen(false)} role="dialog" aria-label={`Settings for ${config.display_name}`}>
    <div className="bot-settings-head">{avatar}<div className="details-bot-copy"><strong>{config.display_name}</strong>{meters}</div></div>
    <fieldset aria-busy={saving}>
      {tool ? <div className="model-select">
        <span className="model-select-label">Model</span>
        <button type="button" className="model-select-trigger" aria-haspopup="menu" aria-expanded={open} onClick={event => { const r = event.currentTarget.getBoundingClientRect(); setMenuPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right - 8), maxHeight: Math.min(320, Math.max(160, window.innerHeight - r.bottom - 12)) }); setOpen(v => !v); setMore(false); }}>
          <span>{model ? current?.label ?? model : 'Default'}</span><svg className="model-select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {open && <div className="model-menu" role="menu" aria-label="Model" style={menuPos}>
          {[{ id: '', label: 'Default' } as { id: string; label?: string | null }, ...shown].map((m, i) => <button key={m.id || 'default'} role="menuitemradio" aria-checked={model === m.id} className="model-menu-item" onClick={() => pickModel(m.id)}>
            <span className="model-menu-name">{m.id ? m.label ?? m.id : 'Default'}{m.id && m.label && <small>{m.id}</small>}</span>
            <span className="model-menu-check">{model === m.id ? '✓' : ''}</span><kbd>{i + 1}</kbd>
          </button>)}
          {extra.length > 0 && <button className="model-menu-item model-menu-more" aria-expanded={more} onClick={() => setMore(v => !v)}>{more ? 'Fewer models' : 'More models'}<span>{more ? '⌃' : '⌄'}</span></button>}
          {more && extra.map(m => <button key={m.id} role="menuitemradio" aria-checked={model === m.id} className="model-menu-item" onClick={() => pickModel(m.id)}>
            <span className="model-menu-name">{m.label ?? m.id}{m.label && <small>{m.id}</small>}</span>
            <span className="model-menu-check">{model === m.id ? '✓' : ''}</span>
          </button>)}
        </div>}
      </div> : <label>Model<Picker name="quick-bot-model" value={model} onChange={value => { setModel(value); touched.current = { ...touched.current, model: value }; }} groups={[]} emptyLabel="Provider default" customLabel="Type a model name…" customPlaceholder="Model name" /></label>}
      {(tool === 'codex' || tool === 'claude_code') && <label><input type="checkbox" checked={touched.current.auto_effort ?? config.auto_effort ?? false} disabled={!efforts.length || (!config.auto_effort && !autoAvailable)} onChange={event => { void apply({ auto_effort: event.target.checked }); }} /> Auto</label>}
      {config.auto_effort && <p className="muted">Trial: Clef logs its pick. Replies use the backup below.</p>}
      {!autoAvailable && (tool === 'codex' || tool === 'claude_code') && <p className="muted">Auto needs the decision observer switched on with a saved key.</p>}
      <ReasoningSlider title={config.auto_effort ? "Auto backup" : "Reasoning"} efforts={efforts} value={supportedEffort} onCommit={value => config.auto_effort ? (setEffort(value), void apply({ effort: value, auto_effort: true })) : commitEffort(value)} />
      {note && <p className="muted">{note}</p>}
      {error && <p role="alert" className="danger-text">{error}</p>}
      {!tool && <div className="bot-settings-actions"><button className="primary" disabled={!model.trim()} onClick={() => void apply({ model, effort: supportedEffort })}>{saving ? 'Saving…' : 'Apply'}</button></div>}
    </fieldset>
  </div>, document.body);
}
