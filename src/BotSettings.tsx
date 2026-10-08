import { popoverTop } from './floating';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Backend } from './backend';
import type { ApiModel, MediaSettings, ModelChoice, ParticipantConfig } from './types';
import { AGENT_EFFORTS, API_EFFORTS, apiModelGroups, contextSize, defaultEffortFor, effortsFor, findModel, modelGroups } from './models';
import { Picker } from './Picker';
import { ReasoningSlider } from './ReasoningSlider';
import { latestSaveQueue } from './settingsSave';
import { applyTurnChange } from './participantSettings';
import { mediaKind, priceLabel, resolveMedia, type ResolvedMedia } from './media';
import { dollars, mediaMenuLine, pictureLine, quoteFor } from './mediaPrice';

/** What a save can carry. */
type Change = { model?: string; effort?: string; auto_effort?: boolean; media?: MediaSettings };

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
  const api = config.backend.kind === 'open_ai_compatible' ? config.backend : null;
  const apiUrl = api?.base_url ?? null;
  const apiKeyEnv = api?.api_key_env ?? null;
  const [apiList, setApiList] = useState<ApiModel[]>([]);
  const [filter, setFilter] = useState('');
  const [model, setModel] = useState('model' in config.backend ? config.backend.model ?? '' : '');
  const [effort, setEffort] = useState(config.effort ?? '');
  const [autoAvailable, setAutoAvailable] = useState(false);
  useEffect(() => { if (tool !== 'codex' && tool !== 'claude_code') return; let active = true; backend.decisionKeyStatus().then(ok => { if (active) setAutoAvailable(ok); }).catch(() => {}); return () => { active = false; }; }, [backend, tool]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const saveRef = useRef(save);
  saveRef.current = save;
  const orderedSave = useRef(latestSaveQueue<{ change: Change; base: ParticipantConfig }>(async value => {
    const state = await backend.roomCreate(roomId, [], { policy: 'mention', max_bot_hops: 0 }, '');
    const current = state.participants.find(p => p.id === value.base.id);
    if (!current) throw new Error('This bot is no longer in the thread.');
    await saveRef.current(applyTurnChange(current, value.change), current);
  }));
  const touched = useRef<Change>({});
  const [settled, setSettled] = useState(0);
  const savedModel = "model" in config.backend ? config.backend.model ?? "" : "";
  const savedEffort = config.effort ?? "";
  const savedMedia = JSON.stringify(config.media ?? {});
  // Picture and video choices, as shown. Changes save at once, like the model.
  const [media, setMedia] = useState<MediaSettings>(config.media ?? {});
  useEffect(() => {
    if (!("model" in touched.current)) { setModel(savedModel); requested.current.model = savedModel; }
    if (!("effort" in touched.current)) { setEffort(savedEffort); requested.current.effort = savedEffort; }
    if (!("media" in touched.current)) setMedia(JSON.parse(savedMedia));
  }, [savedModel, savedEffort, savedMedia, settled]);
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
    if (apiUrl === null) return;
    let active = true;
    backend.apiModels(apiUrl, apiKeyEnv).then(list => { if (active) setApiList(list); }).catch(() => { if (active) setApiList([]); });
    return () => { active = false; };
  }, [backend, apiUrl, apiKeyEnv]);
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
  // The server's own list for API bots. Empty (fallback Picker) when it did not load.
  const rich = api !== null && apiList.length > 0;
  const groups = tool ? modelGroups(tool, reported, tool === 'codex' ? 'Codex' : tool === 'claude_code' ? 'Claude Code' : tool === 'grok' ? 'Grok' : 'Gemini') : rich ? apiModelGroups(apiList) : [];
  const effortsOf = (id: string) => tool ? effortsFor(AGENT_EFFORTS[tool], groups, id) : effortsFor(API_EFFORTS, groups, id);
  const efforts = effortsOf(model);
  const supportedEffort = efforts.includes(effort) ? effort : '';
  const note = findModel(groups, model)?.note;
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number; maxHeight: number; maxWidth?: number }>({ top: 0, right: 0, maxHeight: 260 });
  const all = groups.flatMap(g => g.models);
  const current = all.find(m => m.id === model);
  const apiModel = rich ? apiList.find(m => m.id === model) : undefined;
  // Picture and video models price per picture or per clip instead of per token, and take no reasoning level.
  const mediaType = mediaKind(apiModel);
  const apiPrice = apiModel && !mediaType && (apiModel.price_in != null || apiModel.price_out != null) ? [apiModel.price_in != null ? `${dollars(apiModel.price_in)} in` : '', apiModel.price_out != null ? `${dollars(apiModel.price_out)} out` : ''].filter(Boolean).join(' · ') + ' per million tokens' : '';
  const spec = apiModel?.media ?? {};
  const resolved: ResolvedMedia = mediaType ? resolveMedia(mediaType, spec, media) : { build_on_last: true };
  // A video's price comes from the provider, asked once the settings settle.
  const quoteKey = mediaType === 'video' && apiUrl !== null ? JSON.stringify([model, resolved]) : '';
  const [quote, setQuote] = useState<{ key: string; usd: number | null } | null>(null);
  useEffect(() => {
    if (!quoteKey || apiUrl === null) return;
    let active = true;
    const timer = setTimeout(() => {
      quoteFor(backend, apiUrl, apiKeyEnv, model, resolved).then(usd => { if (active) setQuote({ key: quoteKey, usd }); }, () => { if (active) setQuote({ key: quoteKey, usd: null }); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, quoteKey]);
  const quoting = quoteKey !== '' && quote?.key !== quoteKey;
  const quoted = quote?.key === quoteKey ? quote.usd : null;
  // Rich API list: the filter (over 8 models) replaces the first-4 split; the current model always leads the 4.
  const query = filter.trim().toLowerCase();
  const filtering = rich && all.length > 8;
  const matches = (m: ModelChoice) => !query || m.id.toLowerCase().includes(query) || (m.label ?? '').toLowerCase().includes(query);
  const ordered = rich && current ? [current, ...all.filter(m => m.id !== model)] : all;
  // With Text, Image and Video sections every model is listed under its heading, so none hide behind More models.
  const sections = rich && apiList.some(m => mediaKind(m));
  const shown = rich && query ? all.filter(matches) : sections ? ordered : ordered.slice(0, 4);
  const extra = rich && query || sections ? [] : ordered.slice(4);
  const items: { id: string; label?: string | null }[] = [...(tool || !rich || !savedModel ? [{ id: '', label: tool || !rich ? 'Default' : 'Provider default' }] : []), ...shown];
  // With picture and video models, the menu is headed Text, Image and Video. The current model leads with no heading.
  const sectionOf = new Map(groups.flatMap(g => g.models.map(m => [m.id, g.label] as const)));
  const heads = new Map<string, string>();
  if (sections) {
    let prev = '';
    for (const m of query || !current ? all.filter(matches) : ordered) {
      if (!query && current && m.id === current.id) continue;
      const label = sectionOf.get(m.id) ?? '';
      if (label !== prev) heads.set(m.id, label);
      prev = label;
    }
  }
  const head = (id: string) => heads.get(id) ? <div className="model-menu-head" role="presentation">{heads.get(id)}</div> : null;
  /** Provider models show their name, then size and id on a quieter second line. Pictures and videos show their price. */
  const nameOf = (m: { id: string; label?: string | null }) => {
    const info = rich && m.id ? apiList.find(a => a.id === m.id) : undefined;
    if (info) return <span className="model-menu-name">{info.label || info.id}<small>{mediaKind(info) ? mediaMenuLine(info) : [contextSize(info.context_tokens) && `${contextSize(info.context_tokens)} context`, info.label ? info.id : ''].filter(Boolean).join(' · ')}</small></span>;
    return <span className="model-menu-name">{m.id ? m.label ?? m.id : m.label}{m.id && m.label && <small>{m.id}</small>}</span>;
  };
  const pickModel = (id: string) => {
    setModel(id); setOpen(false); setMore(false); setFilter('');
    const picked = rich ? apiList.find(m => m.id === id) : undefined;
    // A picture or video model takes no reasoning level, so any level set before is cleared.
    if (mediaKind(picked)) { void apply({ model: id, effort: '' }); return; }
    // A provider model with known levels starts on Medium, or the closest level it takes.
    const known = picked?.efforts;
    void apply(known && !known.includes(effort) ? { model: id, effort: defaultEffortFor(known) } : { model: id });
  };
  /** Saves right away; there is no Apply step for agent bots. */
  const apply = async (change: Change) => {
    const sent: Change = { ...touched.current, ...change };
    // Picture and video choices merge with the ones not yet saved, so no change is lost.
    if (change.media) sent.media = { ...touched.current.media, ...change.media };
    const nextModel = sent.model ?? savedModel;
    const nextEffort = sent.effort ?? savedEffort;
    const nextEfforts = effortsOf(nextModel);
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
      if (left.media === sent.media) delete left.media;
      touched.current = left;
      setSettled(n => n + 1);
    }
    catch (error) { if (version === saveVersion.current) { setError(String(error)); requested.current = { model: '\0', effort: '\0' }; } }
    if (version === saveVersion.current) setSaving(false);
  };
  useEffect(() => {
    const pick = (event: KeyboardEvent) => { const n = Number(event.key); if (!(tool || rich) || !open || saving || !(n >= 1 && n <= items.length) || (event.target as HTMLElement).tagName === 'INPUT') return; pickModel(items[n - 1].id); };
    document.addEventListener('keydown', pick);
    return () => document.removeEventListener('keydown', pick);
  });
  const chooseMedia = (patch: MediaSettings) => { setMedia(m => ({ ...m, ...patch })); void apply({ media: patch }); };
  /** A native select for one picture or video choice, when the model lists any. */
  const choice = (label: string, key: 'aspect_ratio' | 'resolution' | 'quality' | 'duration', list: string[] | undefined, value: string | null | undefined) => list?.length
    ? <label className="media-field">{label}<select className="media-select" value={value ?? ''} onChange={e => chooseMedia({ [key]: e.target.value } as MediaSettings)}>{list.map(v => <option key={v} value={v}>{v}</option>)}</select></label>
    : null;
  const mediaBlock = mediaType ? <>
    {mediaType === 'image' && choice('Shape', 'aspect_ratio', spec.aspect_ratios, resolved.aspect_ratio)}
    {mediaType === 'image' && choice('Resolution', 'resolution', spec.resolutions, resolved.resolution)}
    {mediaType === 'image' && choice('Quality', 'quality', spec.qualities, resolved.quality)}
    {mediaType === 'video' && choice('Length', 'duration', spec.durations, resolved.duration)}
    {mediaType === 'video' && choice('Resolution', 'resolution', spec.resolutions, resolved.resolution)}
    {mediaType === 'video' && choice('Shape', 'aspect_ratio', spec.aspect_ratios, resolved.aspect_ratio)}
    {mediaType === 'video' && spec.audio && spec.audio_configurable && <label className="check-label"><input type="checkbox" checked={resolved.audio ?? true} onChange={e => chooseMedia({ audio: e.target.checked })} /> Sound</label>}
    <label className="check-label"><input type="checkbox" checked={resolved.build_on_last} onChange={e => chooseMedia({ build_on_last: e.target.checked })} /> Build on last <span className="muted">· adds to your last description</span></label>
    <p className="muted media-notes">{(mediaType === 'image'
      ? [pictureLine(spec, resolved)]
      : [quoting ? 'Checking price…' : quoted != null ? `Costs ${priceLabel(quoted)} per clip. Deck asks before each one.` : '',
        spec.needs_image ? 'Needs a picture: attach one with your message.' : spec.image_model ? 'Attach a picture to animate it.' : '']
    ).filter(Boolean).map(line => <span key={line}>{line}<br /></span>)}</p>
  </> : null;
  const commitEffort = (value: string) => {
    setEffort(value);
    if (value !== requested.current.effort || model !== requested.current.model) void apply({ effort: value });
  };
  return createPortal(<div ref={root} className="bot-settings" style={position} onScroll={() => setOpen(false)} role="dialog" aria-label={`Settings for ${config.display_name}`}>
    <div className="bot-settings-head">{avatar}<div className="details-bot-copy"><strong>{config.display_name}</strong>{meters}</div></div>
    <fieldset aria-busy={saving}>
      {tool || rich ? <div className="model-select">
        <span className="model-select-label">Model</span>
        <button type="button" className="model-select-trigger" aria-haspopup="menu" aria-expanded={open} onClick={event => { const r = event.currentTarget.getBoundingClientRect(); setMenuPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right - 8), maxHeight: Math.min(320, Math.max(160, window.innerHeight - r.bottom - 12)), ...(rich ? { maxWidth: Math.max(220, r.right - 8) } : {}) }); setOpen(v => !v); setMore(false); setFilter(''); }}>
          <span>{model ? current?.label ?? model : rich ? 'Provider default' : 'Default'}</span><svg className="model-select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {open && <div className={rich ? 'model-menu stacked' : 'model-menu'} role="menu" aria-label="Model" style={menuPos}>
          {filtering && <input className="model-filter" aria-label="Filter models" placeholder="Filter models" value={filter} onChange={event => setFilter(event.currentTarget.value)} />}
          {items.map((m, i) => <Fragment key={m.id || 'default'}>{head(m.id)}<button role="menuitemradio" aria-checked={model === m.id} className="model-menu-item" onClick={() => pickModel(m.id)}>
            {nameOf(m)}
            <span className="model-menu-check">{model === m.id ? '✓' : ''}</span>{i < 9 && <kbd>{i + 1}</kbd>}
          </button></Fragment>)}
          {extra.length > 0 && <button className="model-menu-item model-menu-more" aria-expanded={more} onClick={() => setMore(v => !v)}>{more ? 'Fewer models' : 'More models'}<span>{more ? '⌃' : '⌄'}</span></button>}
          {more && extra.map(m => <Fragment key={m.id}>{head(m.id)}<button role="menuitemradio" aria-checked={model === m.id} className="model-menu-item" onClick={() => pickModel(m.id)}>
            {nameOf(m)}
            <span className="model-menu-check">{model === m.id ? '✓' : ''}</span>
          </button></Fragment>)}
        </div>}
      </div> : <label>Model<Picker name="quick-bot-model" value={model} onChange={value => { setModel(value); touched.current = { ...touched.current, model: value }; }} groups={[]} emptyLabel="Provider default" customLabel="Type a model name…" customPlaceholder="Model name" /></label>}
      {(tool === 'codex' || tool === 'claude_code') && <label className="check-label"><input type="checkbox" checked={touched.current.auto_effort ?? config.auto_effort ?? false} disabled={!efforts.length || (!config.auto_effort && !autoAvailable)} onChange={event => { void apply({ auto_effort: event.target.checked }); }} /> Auto</label>}
      {config.auto_effort && <p className="muted">Trial: Clef logs its pick. Replies use the backup below.</p>}
      {!autoAvailable && (tool === 'codex' || tool === 'claude_code') && <p className="muted">Auto needs the decision observer switched on with a saved key.</p>}
      {!mediaType && <ReasoningSlider title={config.auto_effort ? "Auto backup" : "Reasoning"} efforts={efforts} value={supportedEffort} defaultLabel={apiModel?.default_effort ?? undefined} onCommit={value => config.auto_effort ? (setEffort(value), void apply({ effort: value, auto_effort: true })) : commitEffort(value)} />}
      {apiPrice && <p className="muted">{apiPrice}</p>}
      {mediaBlock}
      {note && <p className="muted">{note}</p>}
      {error && <p role="alert" className="danger-text">{error}</p>}
      {!tool && !rich && <div className="bot-settings-actions"><button className="primary" disabled={!model.trim()} onClick={() => void apply({ model, effort: supportedEffort })}>{saving ? 'Saving…' : 'Apply'}</button></div>}
    </fieldset>
  </div>, document.body);
}
