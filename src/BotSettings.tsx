import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Backend } from './backend';
import type { ModelChoice, ParticipantConfig } from './types';
import { AGENT_EFFORTS, API_EFFORTS, effortLabel, effortsFor, findModel, modelGroups } from './models';
import { Picker } from './Picker';
import { withTurnSettings } from './participantSettings';

interface Props {
  config: ParticipantConfig;
  anchor: HTMLElement;
  backend: Backend;
  save: (config: ParticipantConfig) => Promise<void>;
  close: () => void;
  /** The bot's avatar, shown beside its name. */
  avatar?: ReactNode;
  /** Context and plan bars, shown under the name. */
  meters?: ReactNode;
}
export function BotSettings({ config, anchor, backend, save, close, avatar, meters }: Props) {
  const tool = config.backend.kind === 'agent' ? config.backend.tool : null;
  const [reported, setReported] = useState<ModelChoice[]>([]);
  const [model, setModel] = useState('model' in config.backend ? config.backend.model ?? '' : '');
  const [effort, setEffort] = useState(config.effort ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = root.current?.offsetHeight ?? 260;
    setPosition({ top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8)), left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)) });
    root.current?.querySelector<HTMLSelectElement>('select')?.focus();
  }, [anchor]);
  useEffect(() => {
    let active = true;
    if (tool) backend.agentModels(tool).then(list => { if (active) setReported(list); }).catch(() => {});
    return () => { active = false; };
  }, [backend, tool]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); anchor.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', close); };
  }, [anchor, close]);
  const groups = tool ? modelGroups(tool, reported, tool === 'codex' ? 'Codex' : tool === 'claude_code' ? 'Claude Code' : 'Gemini') : [];
  const efforts = tool ? effortsFor(AGENT_EFFORTS[tool], groups, model) : API_EFFORTS;
  const supportedEffort = efforts.includes(effort) ? effort : '';
  const note = findModel(groups, model)?.note;
  return createPortal(<div ref={root} className="bot-settings" style={position} role="dialog" aria-label={`Settings for ${config.display_name}`}>
    <div className="bot-settings-head">{avatar}<div className="details-bot-copy"><strong>{config.display_name}</strong>{meters}</div></div>
    <fieldset disabled={saving}>
      <label>Model<Picker name="quick-bot-model" value={model} onChange={setModel} groups={groups.map(g => ({ label: g.label, options: g.models.map(m => ({ value: m.id, text: m.label ? `${m.id} · ${m.label}` : m.id })) }))} emptyLabel="Provider default" customLabel="Type a model name…" customPlaceholder="Model name" /></label>
      <label>Reasoning<select aria-label="Reasoning" value={supportedEffort} disabled={efforts.length === 0} onChange={e => setEffort(e.target.value)}><option value="">{efforts.length ? 'Provider default' : 'Not supported'}</option>{efforts.map(e => <option key={e} value={e}>{effortLabel(e)}</option>)}</select></label>
      {note && <p className="muted">{note}</p>}
      {error && <p role="alert" className="danger-text">{error}</p>}
      <div className="bot-settings-actions"><button onClick={() => { close(); anchor.focus(); }}>Cancel</button><button className="primary" disabled={config.backend.kind === 'open_ai_compatible' && !model.trim()} onClick={async () => {
        setSaving(true); setError('');
        try { await save(withTurnSettings(config, model, supportedEffort, efforts)); close(); anchor.focus(); }
        catch (error) { setError(String(error)); setSaving(false); }
      }}>{saving ? 'Saving…' : 'Apply'}</button></div>
    </fieldset>
  </div>, document.body);
}
