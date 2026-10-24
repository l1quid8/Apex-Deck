import { menuPlacement, popoverTop } from './floating';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Backend } from './backend';
import type { Access, ApiModel, MediaSettings, ModelChoice, ParticipantConfig, Speed } from './types';
import { Segmented } from './AgentPicker';
import { SPEED_OPTIONS, supportsSpeed, speedHint } from './speed';
import { AGENT_EFFORTS, API_EFFORTS, apiModelGroups, contextSize, defaultEffortFor, effortsFor, findModel, modelGroups } from './models';
import { ReasoningSlider } from './ReasoningSlider';
import { latestSaveQueue } from './settingsSave';
import { applyTurnChange } from './participantSettings';
import { mediaKind, priceLabel, resolveMedia, type ResolvedMedia } from './media';
import { dollars, mediaMenuLine, pictureLine, quoteFor } from './mediaPrice';

/** What a save can carry. */
type Change = { model?: string; effort?: string; speed?: Speed | null; access?: Access; media?: MediaSettings };

interface Props {
  config: ParticipantConfig;
  roomId?: string;
  /** The control this popover hangs from. Absent when `inline` is set. */
  anchor?: HTMLElement | null;
  /** Draw the same controls in the page instead of a floating panel. */
  inline?: boolean;
  backend: Backend;
  save: (config: ParticipantConfig, base: ParticipantConfig) => Promise<void>;
  close: () => void;
  /** The bot's avatar, shown beside its name. */
  avatar?: ReactNode;
  /** Context and plan bars, shown under the name. */
  meters?: ReactNode;
  accessPending?: boolean;
  /** The provider's usage resets, shown under Access. */
  resets?: ReactNode;
  /** Assistant-owned snapshots never create or fetch a room. */
  loadCurrent?: () => Promise<ParticipantConfig>;
  /** Provider selection and the route to full Settings. */
  provider?: ReactNode;
  disabledReason?: string;
  textOnly?: boolean;
  allowManualModel?: boolean;
  allowDefaultModel?: boolean;
  /** Owning-host text choices for a scoped assistant; no generic fallback models. */
  offeredModels?: ModelChoice[];
}
export function BotSettings({ config, roomId, anchor = null, inline = false, backend, save, close, avatar, meters, accessPending = false, resets, loadCurrent, provider, disabledReason, textOnly = false, allowManualModel = true, allowDefaultModel = true, offeredModels }: Props) {
  const tool = config.backend.kind === 'agent' ? config.backend.tool : null;
  const [reported, setReported] = useState<ModelChoice[]>([]);
  const api = config.backend.kind === 'open_ai_compatible' ? config.backend : null;
  const apiUrl = api?.base_url ?? null;
  const apiKeyEnv = api?.api_key_env ?? null;
  const [apiList, setApiList] = useState<ApiModel[]>([]);
  const [filter, setFilter] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [discovery, setDiscovery] = useState<'loading' | 'ready' | 'empty'>('loading');
  const [model, setModel] = useState('model' in config.backend ? config.backend.model ?? '' : '');
  const [effort, setEffort] = useState(config.effort ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const saveRef = useRef(save);
  saveRef.current = save;
  const loadCurrentRef = useRef(loadCurrent);
  loadCurrentRef.current = loadCurrent;
  const orderedSave = useRef(latestSaveQueue<{ change: Change; base: ParticipantConfig }>(async value => {
    const current = loadCurrentRef.current ? await loadCurrentRef.current() : roomId ? (await backend.roomCreate(roomId, [], { policy: 'mention', max_bot_hops: 0 }, '')).participants.find(p => p.id === value.base.id) : undefined;
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Placed again when it grows or shrinks, as when the Resets list opens, so it stays on screen.
    if (inline || !anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const height = root.current?.offsetHeight ?? 260;
      setPosition({ top: popoverTop(rect, height, window.innerHeight), left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)) });
    };
    place();
    root.current?.querySelector<HTMLElement>('[aria-checked="true"], input, select')?.focus();
    if (!root.current || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(place);
    watch.observe(root.current);
    return () => watch.disconnect();
  }, [anchor, inline]);
  useEffect(() => {
    if (apiUrl === null) return;
    let active = true;
    setApiList([]); setDiscovery('loading');
    backend.apiModels(apiUrl, apiKeyEnv).then(list => { if (active) { const offered = textOnly ? list.filter(model => !model.kind || model.kind === 'text') : list; setApiList(offered); setDiscovery(offered.length ? 'ready' : 'empty'); } }).catch(() => { if (active) { setApiList([]); setDiscovery('empty'); } });
    return () => { active = false; };
  }, [backend, apiUrl, apiKeyEnv, textOnly]);
  useEffect(() => {
    let active = true;
    if (tool) {
      setReported([]); setDiscovery('loading');
      backend.agentModels(tool).then(list => { if (active) { setReported(list); setDiscovery(list.length ? 'ready' : 'empty'); } }).catch(() => { if (active) setDiscovery('empty'); });
    }
    return () => { active = false; };
  }, [backend, tool]);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number; maxHeight: number; maxWidth?: number }>({ right: 0, maxHeight: 260 });
  useEffect(() => {
    if (inline) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      if (open) setOpen(false);
      if (!root.current?.contains(target) && !anchor?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (open) {
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
          return;
        }
        event.stopPropagation();
        close();
        anchor?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', close);
    };
  }, [anchor, close, open, inline]);
  // API metadata also controls pricing and media-specific settings.
  const rich = api !== null && apiList.length > 0;
  const groups = offeredModels ? [{ label: 'Models', models: offeredModels }] : tool ? modelGroups(tool, reported, tool === 'codex' ? 'Codex' : tool === 'claude_code' ? 'Claude Code' : tool === 'grok' ? 'Grok' : tool === 'muse' ? 'Muse Code' : 'Antigravity') : rich ? apiModelGroups(apiList) : [];
  const effortsOf = (id: string) => tool ? effortsFor(AGENT_EFFORTS[tool], groups, id) : effortsFor(API_EFFORTS, groups, id);
  const efforts = effortsOf(model);
  const supportedEffort = efforts.includes(effort) ? effort : '';
  const note = findModel(groups, model)?.note;
  const all = groups.flatMap(g => g.models);
  const current = all.find(m => m.id === model) ?? (model ? { id: model } : undefined);
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
  // Every provider gets search and the current model first, even for custom IDs.
  const query = filter.trim().toLowerCase();
  const matches = (m: ModelChoice) => !query || m.id.toLowerCase().includes(query) || (m.label ?? '').toLowerCase().includes(query);
  const ordered = (current ? [current, ...all.filter(m => m.id !== model)] : all).filter(m=>m.id);
  // With Text, Image and Video sections every model is listed under its heading, so none hide behind More models.
  const sections = rich && apiList.some(m => mediaKind(m));
  const shown = query ? ordered.filter(matches) : sections ? ordered : ordered.slice(0, 4);
  const extra = query || sections ? [] : ordered.slice(4);
  const defaultItem = { id: '', label: tool ? 'Default' : 'Provider default' };
  const items: { id: string; label?: string | null }[] = query ? shown : model ? [...shown, defaultItem] : [defaultItem, ...shown];
  // With picture and video models, the menu is headed Text, Image and Video. The current model leads with no heading.
  const sectionOf = new Map(groups.flatMap(g => g.models.map(m => [m.id, g.label] as const)));
  const heads = new Map<string, string>();
  if (sections) {
    let prev = '';
    for (const m of ordered.filter(matches)) {
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
    if (disabledReason || (!allowDefaultModel && !id) || (offeredModels && !offeredModels.some(item => item.id === id))) return;
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
    if (disabledReason) return;
    const sent: Change = { ...touched.current, ...change };
    // Picture and video choices merge with the ones not yet saved, so no change is lost.
    if (change.media) sent.media = { ...touched.current.media, ...change.media };
    const nextModel = sent.model ?? savedModel;
    const nextEffort = sent.effort ?? savedEffort;
    const nextEfforts = effortsOf(nextModel);
    const normalizedEffort = nextEfforts.includes(nextEffort) ? nextEffort : '';
    // A model with no reasoning support explicitly clears the old level.
    if ('model' in sent && normalizedEffort !== nextEffort) sent.effort = normalizedEffort;
    touched.current = sent;
    requested.current = { model: nextModel, effort: normalizedEffort };
    const version = ++saveVersion.current;
    setSaving(true); setError('');
    try {
      await orderedSave.current({ change: sent, base: config });
      const left = { ...touched.current };
      if (left.model === sent.model) delete left.model;
      if (left.effort === sent.effort) delete left.effort;
      if (left.speed === sent.speed) delete left.speed;
      if (left.access === sent.access) delete left.access;
      if (left.media === sent.media) delete left.media;
      touched.current = left;
      setSettled(n => n + 1);
    }
    catch (error) { if (version === saveVersion.current) { setError(String(error)); delete touched.current.access; setSettled(n => n + 1); requested.current = { model: '\0', effort: '\0' }; } }
    if (version === saveVersion.current) setSaving(false);
  };
  useEffect(() => {
    const pick = (event: KeyboardEvent) => { const n = Number(event.key); if (!open || saving || disabledReason || !(n >= 1 && n <= items.length) || (event.target as HTMLElement).tagName === 'INPUT') return; pickModel(items[n - 1].id); };
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
  const access = touched.current.access ?? config.access;
  const accessOptions: { value: Access; text: string; title: string }[] = [
    { value: 'read', text: 'Read-only', title: 'Read files. No edits or commands.' },
    ...(!(tool === 'grok' || tool === 'muse') ? [{ value: 'ask' as const, text: 'Ask', title: 'Ask before edits and commands.' }] : []),
    { value: 'edits', text: 'Edit', title: 'Edit files; ask before commands where supported.' },
    { value: 'full', text: 'Full', title: 'Full access.' },
  ];
  const commitEffort = (value: string) => {
    setEffort(value);
    if (value !== requested.current.effort || model !== requested.current.model) void apply({ effort: value });
  };
  const toggleMenu = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const place = menuPlacement(r, { width: window.innerWidth, height: window.innerHeight });
      setMenuPos({ ...place, ...(rich ? { maxWidth: Math.max(220, r.right - 8) } : {}) });
      setMore(false);
      setFilter('');
      setOpen(true);
    } else {
      setOpen(false);
    }
  };
  const panel = <div ref={root} className={inline ? 'bot-settings is-inline' : 'bot-settings'} style={inline ? undefined : position} onScroll={() => setOpen(false)} role={inline ? 'group' : 'dialog'} aria-label={`Settings for ${config.display_name}`}>
    <div className="bot-settings-head">{avatar}<div className="details-bot-copy"><strong>{config.display_name}</strong>{meters}</div></div>
    {provider}
    {disabledReason && <p role="status" className="muted">{disabledReason}</p>}
    <fieldset aria-busy={saving} disabled={!!disabledReason}>
      <div className="model-select">
        <span className="model-select-label">Model</span>
        <button ref={triggerRef} type="button" className="model-select-trigger" aria-haspopup="menu" aria-expanded={open} onClick={toggleMenu}>
          <span>{model ? current?.label ?? model : rich ? 'Provider default' : 'Default'}</span><svg className="model-select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {open && createPortal(
          <div ref={menuRef} className={rich ? 'model-menu stacked' : 'model-menu'} role="menu" aria-label="Model" style={menuPos}>
            <input autoFocus className="model-filter" aria-label="Filter models" placeholder="Filter models" value={filter} onChange={event => setFilter(event.currentTarget.value)} />
            {query && !shown.length && <p className="muted">No matching models.</p>}
            {items.map((m, i) => <Fragment key={m.id || 'default'}>{head(m.id)}<button role="menuitemradio" aria-checked={model === m.id} className="model-menu-item" disabled={!!disabledReason || (!allowDefaultModel && !m.id) || (!!offeredModels && !offeredModels.some(item => item.id === m.id))} onClick={() => pickModel(m.id)}>
              {nameOf(m)}
              <span className="model-menu-check">{model === m.id ? '✓' : ''}</span>{i < 9 && <kbd>{i + 1}</kbd>}
            </button></Fragment>)}
            {extra.length > 0 && <button className="model-menu-item model-menu-more" aria-expanded={more} onClick={() => setMore(v => !v)}>{more ? 'Fewer models' : 'More models'}<span>{more ? '⌃' : '⌄'}</span></button>}
            {more && extra.map(m => <Fragment key={m.id}>{head(m.id)}<button role="menuitemradio" aria-checked={model === m.id} className="model-menu-item" disabled={!!disabledReason || (!allowDefaultModel && !m.id) || (!!offeredModels && !offeredModels.some(item => item.id === m.id))} onClick={() => pickModel(m.id)}>
              {nameOf(m)}
              <span className="model-menu-check">{model === m.id ? '✓' : ''}</span>
            </button></Fragment>)}
            {discovery === 'loading' && <p className="muted">Loading models…</p>}
            {discovery === 'empty' && allowManualModel && <div className="model-manual">
              <p className="muted">Model discovery unavailable. Enter a model ID.</p>
              <input aria-label="Model name" placeholder="Model ID" value={manualModel} onChange={event => setManualModel(event.currentTarget.value)} onKeyDown={event => {
                if (event.key === 'Enter' && manualModel.trim()) { event.preventDefault(); pickModel(manualModel.trim()); }
              }} />
              <button type="button" disabled={!manualModel.trim()} onClick={() => pickModel(manualModel.trim())}>Use model</button>
            </div>}
          </div>,
          document.body
        )}
      </div>
      {!mediaType && <ReasoningSlider efforts={efforts} value={supportedEffort} defaultLabel={apiModel?.default_effort ?? undefined} onCommit={commitEffort} />}
      {supportsSpeed(config.backend) && <div className="bot-speed" title={speedHint(tool ?? undefined)}><span className="model-select-label">Speed</span><Segmented label="Speed" name="quick-bot-speed" options={SPEED_OPTIONS} value={'speed' in touched.current ? touched.current.speed ?? '' : config.speed ?? ''} onChange={speed => { void apply({ speed: speed || null }); }} /></div>}
      {(tool || api) && <>
        <div className="bot-access"><span className="model-select-label">Access</span><Segmented label="Access" name="quick-bot-access" options={accessOptions} value={access} onChange={access => { void apply({ access }); }} /></div>
        {accessPending && <p className="muted bot-access-note" role="status">Applies after this reply.</p>}
      </>}
      {resets}
      {apiPrice && <p className="muted">{apiPrice}</p>}
      {mediaBlock}
      {note && <p className="muted">{note}</p>}
      {error && <p role="alert" className="danger-text">{error}</p>}
    </fieldset>
  </div>;
  return inline ? panel : createPortal(panel, document.body);
}
