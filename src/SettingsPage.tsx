// Settings: reorganized for usability - grouped nav, search, true black palette, explicit Light/Dark/System
import { artifactAutoOpen, setArtifactAutoOpen } from "./artifacts";
import { AppearanceStudio } from "./AppearanceStudio";
import type { AppearanceStudioState } from "./useAppearanceDraft";
import { useSystemDark } from "./useAppearance";
import { CATALOG_SECTIONS, CATALOG_ENTRIES, groupSections, searchSettings as catalogSearch, resolveSectionId, type SettingsSectionId, type CatalogEntry } from "./settingsCatalog";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Backend, KeyState } from "./backend";
import { forgetModels, rememberedModels } from "./modelMemory";
import { providerEnabled } from "./providers";
import { CALL_VOICES, DEFAULT_META_MODEL, DEFAULT_REALTIME_MODEL, DEFAULT_REALTIME_VOICE, META_MODELS, REALTIME_MODELS, REALTIME_VOICES, defaultVoiceOf, readVoiceSettings, realtimeVoiceLabel } from "./voice/settings";
import { VoiceSampleButton } from "./voice/VoiceSampleButton";
import { CALL_LOOKS, voiceLabel } from "./voice/callView";
import { FONT_SIZES, MAX_ROUNDS, SCROLLBACK_CHOICES, keyNamesIn, type AppSettings } from "./settings";
import { HostsSettings } from "./HostsSettings";
import { LegacyImportPanel } from "./LegacyImportScreen";
import { ModelGatewaySettings } from "./ModelGatewaySettings";
import { gatewayOwner } from "./modelGateway";
import { ModsSettings } from "./ModsSettings";
import { PhonesSettings } from "./PhonesSettings";
import { ComputerUseSettings } from "./ComputerUseSettings";
import { shortcutList } from "./shortcuts";
import { updateActions, updateNote, type UpdateStatus } from "./updates.ts";
import type { Access, AgentInfo, ParticipantConfig, TurnPolicy } from "./types";

// Back-compat + new ids
export type SettingsSection = 'general' | 'appearance' | 'hosts' | 'phones' | 'providers' | 'gateway' | 'calls' | 'threads' | 'terminal' | 'mods' | 'shortcuts' | 'computer' | 'models' | 'computers' | 'extensions' | 'data' | 'about';

const LEGACY_TO_NEW: Record<string, SettingsSectionId> = {
  hosts: 'computers',
  providers: 'models',
  mods: 'extensions',
  general: 'general',
  appearance: 'appearance',
  phones: 'phones',
  gateway: 'gateway',
  calls: 'calls',
  threads: 'threads',
  terminal: 'terminal',
  shortcuts: 'shortcuts',
  computer: 'computer',
  models: 'models',
  computers: 'computers',
  extensions: 'extensions',
  data: 'data',
  about: 'about',
};

const LEADS: Partial<Record<SettingsSectionId, string>> = {
  general: "The everyday details that make Deck yours. Artifact handling and code-block Run buttons live here; other groups live nearby.",
    calls: "Choose how you talk with your agents. Local and GPT-Live keep their preferences separately.",
  threads: "A starting point for the next conversation. Existing threads keep their own settings.",
  terminal: "Make the terminal comfortable to work in. Open terminals update straight away.",
  models: "Your models, connected and ready when you need them. Choose what appears when adding agents.",
  computers: "The machines where your work happens. Friendly name, connection status, and actionable recovery.",
  phones: "Your paired devices and what each can access. Stable device identity underneath friendly names.",
  computer: "Let your agents work with the apps on this Mac, with your permission. Thread grants and cursor preferences first.",
  extensions: "Add capabilities to the way you work. Status, purpose, commands, and declared capabilities.",
  gateway: "Share your model stack through an endpoint you control. Client access keys are different from provider API keys.",
  data: "Your work stays in a place you control. Location, legacy import, and remembered suggestions.",
  about: "Apex Deck, and what comes next. Version, update status, and diagnostics.",
  shortcuts: "Keep the things you use close at hand. Fixed shortcuts are grouped for scanning.",
};

const ICONS: Record<SettingsSectionId, string> = {
  general: '⚙',
  appearance: '◐',
  calls: '◌',
  threads: '▤',
  terminal: '›_',
  models: '▦',
  computers: '▱',
  phones: '▯',
  computer: '⌘',
  extensions: '◇',
  gateway: '⇄',
  data: '▧',
  about: 'ⓘ',
  shortcuts: '⌨',
};

interface Props {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  appearanceStudio: AppearanceStudioState;
  agents: AgentInfo[];
  profiles: ParticipantConfig[];
  backend: Backend;
  updates?: UpdateStatus | null;
  onRestartToUpdate?: () => void;
  onClose: () => void;
}

function Row({ id, label, note, children, highlight }: { id?: string; label: string; note?: ReactNode; children?: ReactNode; highlight?: boolean }) {
  return <div className={`settings-row ${highlight ? 'highlight' : ''}`} id={id} tabIndex={-1}>
    <div className="settings-label"><strong>{label}</strong>{note && <small>{note}</small>}</div>
    {children}
  </div>;
}

function Stepper({ value, min, max, unit, label, onChange }: { value: number; min: number; max: number; unit?: string; label: string; onChange: (value: number) => void }) {
  return <span className="stepper">
    <button type="button" aria-label={`Less ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
    <output aria-label={label}>{value}{unit ? ` ${unit}` : ""}</output>
    <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
  </span>;
}

function ScopeBadge({ label }: { label: string }) {
  return <span className="settings-scope-badge">{label}</span>;
}

export function SettingsPage({ section, onSection, settings, onChange, appearanceStudio, agents, profiles, backend, updates = null, onRestartToUpdate, onClose }: Props) {
  const systemDark = useSystemDark();
  const navFocusRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Resolve incoming legacy section to new
  const resolvedSection: SettingsSectionId = useMemo(() => {
    const mapped = LEGACY_TO_NEW[section] ?? (resolveSectionId(section) as SettingsSectionId | null) ?? 'general';
    return mapped;
  }, [section]);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CatalogEntry[]>([]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [focusedResultIdx, setFocusedResultIdx] = useState(-1);
  const pendingOps = useRef<Map<string, { seq: number; state: 'saving' | 'saved' | 'error' }>>(new Map());
  const idleTimer = useRef<any>(null);
  const lastSettingsJson = useRef<string>('');
  const expandedAdvanced = useRef<Set<string>>(new Set());

  // Visible section ids based on backend capabilities
  const visibleSections = useMemo(() => {
    const ids = new Set<SettingsSectionId>(CATALOG_SECTIONS.map(s=>s.id));
    if (backend.demo || !backend.hosts) {
      ids.delete('computers' as any);
      ids.delete('phones' as any);
    }
    if (!gatewayOwner(backend)) ids.delete('gateway');
    return ids;
  }, [backend]);

  const grouped = useMemo(() => groupSections().map(g=>({ ...g, sections: g.sections.filter(s=>visibleSections.has(s.id))})).filter(g=>g.sections.length>0), [visibleSections]);

  useEffect(() => { navFocusRef.current?.querySelector<HTMLButtonElement>("button.active")?.focus(); }, [resolvedSection]);
  // Arriving at a section means leaving the results, or the page would stay hidden behind them.
  useEffect(() => { setSearchQuery(''); setSearchResults([]); setFocusedResultIdx(-1); }, [resolvedSection]);

  // Keyboard: Escape clears search before closing, Cmd+F focuses search, Arrow nav for results
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        setFocusedResultIdx(searchResults.length ? 0 : -1);
        return;
      }
      // Search result keyboard navigation when search active
      if (searchQuery && searchResults.length) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setFocusedResultIdx(prev => {
            const next = prev < 0 ? 0 : Math.min(prev + 1, searchResults.length - 1);
            // focus the button element
            requestAnimationFrame(() => {
              const btn = mainRef.current?.querySelectorAll('.search-result')[next] as HTMLElement | undefined;
              btn?.focus();
            });
            return next;
          });
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setFocusedResultIdx(prev => {
            const next = prev <= 0 ? searchResults.length - 1 : prev - 1;
            requestAnimationFrame(() => {
              const btn = mainRef.current?.querySelectorAll('.search-result')[next] as HTMLElement | undefined;
              btn?.focus();
            });
            return next;
          });
          return;
        }
        if (event.key === 'Enter' && focusedResultIdx >= 0) {
          event.preventDefault();
          const entry = searchResults[focusedResultIdx];
          if (entry) navigateToResult(entry);
          return;
        }
      }
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (searchQuery) {
          event.preventDefault();
          setSearchQuery('');
          setSearchResults([]);
          setFocusedResultIdx(-1);
          searchRef.current?.focus();
          return;
        }
        // Close innermost disclosure or settings
        const openDetails = mainRef.current?.querySelector('details[open]') as HTMLDetailsElement | null;
        if (openDetails) {
          event.preventDefault();
          openDetails.open = false;
          (openDetails.querySelector('summary') as HTMLElement)?.focus();
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, searchQuery, searchResults, focusedResultIdx]);

  const handleSearch = useCallback((q: string) => {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); setFocusedResultIdx(-1); return; }
    const results = catalogSearch(q, CATALOG_ENTRIES, visibleSections);
    setSearchResults(results);
    setFocusedResultIdx(results.length ? 0 : -1);
  }, [visibleSections]);

  const navigateToResult = useCallback((entry: CatalogEntry) => {
    const targetSection = entry.section;
    if (targetSection !== resolvedSection) onSection(targetSection as SettingsSection);
    setSearchQuery('');
    setSearchResults([]);
    setHighlightId(entry.anchorId);
    // Expand advanced if needed
    if (entry.advanced) {
      expandedAdvanced.current.add(entry.section + '-' + entry.id);
    }
    requestAnimationFrame(() => {
      // Try find element by id, or fallback to section
      let el = document.getElementById(entry.anchorId);
      if (!el) el = document.getElementById(entry.id);
      // Special: appearance chip style etc inside appearance page
      if (!el) el = mainRef.current?.querySelector(`[id="${entry.anchorId}"]`) as HTMLElement;
      if (el) {
        const details = el.closest('details');
        if (details) (details as HTMLDetailsElement).open = true;
        el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        (el as HTMLElement).focus({ preventScroll: true });
        const target = el;
        target.classList.add('search-highlight');
        setTimeout(()=>target.classList.remove('search-highlight'), 2200);
      } else {
        mainRef.current?.focus();
      }
    });
  }, [onSection, resolvedSection]);

  // Save feedback — tied to actual versioned persistence operations.
  // Never synthesize "Saved" from elapsed time (no timer-based success claim).
  useEffect(() => {
    const json = (() => { try { return JSON.stringify(settings); } catch { return ''; } })();
    if (lastSettingsJson.current === json) return;
    const isInitial = lastSettingsJson.current === '';
    lastSettingsJson.current = json;
    if (isInitial || json === '') return;
    // An edit occurred: enter saving state immediately until actual persistence ack or error arrives
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setSaveState('saving');
  }, [settings]);

  // Listen for storage save errors or successful save events.
  useEffect(() => {
    const update = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      const states = [...pendingOps.current.values()].map(op => op.state);
      const state = states.includes('error') ? 'error' : states.includes('saving') ? 'saving' : 'saved';
      setSaveState(state);
      if (state === 'saved') idleTimer.current = setTimeout(() => {
        setSaveState(current => current === 'saved' ? 'idle' : current);
      }, 1800);
    };
    const detailOf = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      return detail && typeof detail.source === 'string' && Number.isSafeInteger(detail.seq)
        ? detail as {source: string; seq: number} : null;
    };
    const onSavePending = (e: Event) => {
      const detail = detailOf(e);
      if (!detail) return;
      const current = pendingOps.current.get(detail.source);
      if (current && current.seq >= detail.seq) return;
      pendingOps.current.set(detail.source, {seq: detail.seq, state: 'saving'});
      update();
    };
    const finish = (e: Event, state: 'saved' | 'error') => {
      const detail = detailOf(e);
      if (!detail) return;
      const current = pendingOps.current.get(detail.source);
      if (!current || current.seq !== detail.seq || current.state !== 'saving') return;
      pendingOps.current.set(detail.source, {seq: detail.seq, state});
      update();
    };
    const onSaved = (e: Event) => finish(e, 'saved');
    const onStorageError = (e: Event) => finish(e, 'error');
    window.addEventListener('settings-save-pending', onSavePending);
    window.addEventListener('settings-saved', onSaved);
    window.addEventListener('settings-save-error', onStorageError);
    return () => {
      window.removeEventListener('settings-save-pending', onSavePending);
      window.removeEventListener('settings-saved', onSaved);
      window.removeEventListener('settings-save-error', onStorageError);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  const currentSec = CATALOG_SECTIONS.find(s=>s.id===resolvedSection) ?? CATALOG_SECTIONS[0];
  const index = CATALOG_SECTIONS.findIndex(s=>s.id===resolvedSection);

  const searching = searchResults.length>0 || Boolean(searchQuery.trim());
  const studio = resolvedSection==='appearance' && !searching;

  return <div className={`settings settings-v2${resolvedSection==='appearance' ? ' appearance-neutral' : ''}`}>
    <aside className="settings-nav settings-nav-v2">
      <div className="settings-nav-head">
        <h1>Settings</h1>
        <button className="icon" onClick={onClose} aria-label="Close settings" title="Close settings (Esc)">×</button>
      </div>
      <div className="settings-search-wrap">
        <span aria-hidden="true" className="search-icon">⌕</span>
        <input ref={searchRef} type="search" aria-label="Search settings" placeholder="Search settings" value={searchQuery} onChange={e=>handleSearch(e.target.value)} />
        <kbd>⌘ F</kbd>
        {searchQuery && <button className="icon search-clear" aria-label="Clear search" onClick={()=>handleSearch('')}>×</button>}
      </div>
      <nav ref={navFocusRef} aria-label="Settings sections">
        {grouped.map(group => (
          <details key={group.title} open={group.sections.some(s=>s.id===resolvedSection) || group.title==='Everyday'}>
            <summary>{group.title}</summary>
            <div className="nav-group">
              {group.sections.map(s => (
                <button key={s.id} className={s.id===resolvedSection ? "active nav-item" : "nav-item"} aria-current={s.id===resolvedSection ? "page" : undefined} onClick={()=>onSection(s.id as SettingsSection)} title={s.purpose}>
                  <span className="nav-icon" aria-hidden="true">{ICONS[s.id] ?? '•'}</span>
                  <span className="nav-label">{s.label}</span>
                {s.id==='appearance' && appearanceStudio.pending.length>0 && <span className="appearance-draft-count" aria-label={`${appearanceStudio.pending.length} unapplied`}>{appearanceStudio.pending.length}</span>}</button>
              ))}
            </div>
          </details>
        ))}
      </nav>
      <div className="settings-nav-foot">
        <span className="save-state-inline" role="status" aria-live="polite">
          {saveState==='saving' ? 'Saving…' : saveState==='saved' ? '✓ Saved' : saveState==='error' ? 'Could not save' : ''}
        </span>
        <span><kbd>⌘,</kbd> opens · <kbd>Esc</kbd> closes</span>
        <span>{resolvedSection==='appearance' ? 'Appearance changes wait for Apply.' : 'Changes save as you make them.'}</span>
      </div>
    </aside>
    <main className={`settings-main${studio ? ' studio-main' : ''}`} ref={mainRef} tabIndex={-1}>
      {studio ? <AppearanceStudio studio={appearanceStudio} settings={settings} systemDark={systemDark} highlightId={highlightId} onHighlightUsed={()=>setHighlightId(null)} /> : <div className="settings-column">
        {searchResults.length>0 || searchQuery.trim() ? (
          <div className="settings-search-results">
            <div className="settings-head">
              <span className="mono settings-scope-badge">Search</span>
              <h2>Find a setting</h2>
              <p>{searchResults.length} {searchResults.length===1 ? 'result' : 'results'} for "{searchQuery}"</p>
            </div>
            <div className="settings-card search-results-card">
              {searchResults.length ? searchResults.map(r=>(
                <button key={r.id + r.section} className="search-result" onClick={()=>navigateToResult(r)}>
                  <strong>{r.label}</strong>
                  <span>{CATALOG_SECTIONS.find(s=>s.id===r.section)?.label} · {r.scopeLabel}{r.advanced ? ' · Advanced' : ''}</span>
                </button>
              )) : <div className="settings-empty"><strong>No settings found</strong><span>Try voice, dark, SSH, API key or cursor.</span></div>}
            </div>
          </div>
        ) : (
          <>
            <header className="settings-head">
              <span className="settings-top-line"><ScopeBadge label={currentSec.scopeLabel} /><span className="pill">{currentSec.group==='maintenance' ? 'Advanced settings' : 'Your preferences'}</span></span>
              <span className="mono small">{String((index>=0?index:0)+1).padStart(2,'0')} / {CATALOG_SECTIONS.length} · {currentSec.label}</span>
              <h2>{currentSec.id==='threads' ? 'Defaults for new threads' : currentSec.label}</h2>
              {LEADS[currentSec.id] && <p>{LEADS[currentSec.id]}</p>}
            </header>

            {resolvedSection==='general' && <General settings={settings} onChange={onChange} backend={backend} updates={updates} onRestartToUpdate={onRestartToUpdate} onSection={onSection} />}
            {resolvedSection==='computers' && backend.hosts && <HostsSection backend={backend} />}
            {resolvedSection==='phones' && backend.hosts && <PhonesSection backend={backend} />}
            {resolvedSection==='computer' && <ComputerSection backend={backend} highlightId={highlightId} />}
            {resolvedSection==='gateway' && <GatewaySection backend={backend} highlightId={highlightId} />}
            {resolvedSection==='models' && <ProvidersSection settings={settings} onChange={onChange} agents={agents} profiles={profiles} backend={backend} highlightId={highlightId} />}
            {resolvedSection==='calls' && <CallsSection settings={settings} onChange={onChange} backend={backend} highlightId={highlightId} />}
            {resolvedSection==='threads' && <ThreadsSection settings={settings} onChange={onChange} highlightId={highlightId} />}
            {resolvedSection==='terminal' && <TerminalSection settings={settings} onChange={onChange} highlightId={highlightId} />}
            {resolvedSection==='extensions' && <ExtensionsSection backend={backend} highlightId={highlightId} />}
            {resolvedSection==='shortcuts' && <ShortcutsSection highlightId={highlightId} />}
            {resolvedSection==='data' && <DataSection settings={settings} onChange={onChange} backend={backend} onSection={onSection} />}
            {resolvedSection==='about' && <AboutSection backend={backend} updates={updates} onRestartToUpdate={onRestartToUpdate} highlightId={highlightId} />}

            <div className="settings-footer-save" role="status" aria-live="polite">
              <span className={`save-indicator ${saveState}`}>{saveState==='saving' ? 'Saving…' : saveState==='saved' ? '✓ Saved' : saveState==='error' ? 'Could not save — will retry' : ''}</span>
            </div>
          </>
        )}
      </div>}
    </main>
  </div>;
}

function Advanced({ title, defaultOpen, id, children }: { title: string; defaultOpen?: boolean; id?: string; children: ReactNode }) {
  return <details className="settings-advanced" id={id} open={defaultOpen}><summary>{title}</summary><div className="advanced-body">{children}</div></details>;
}

/** Sites the docked browser remembers an answer for; removing one asks again next time. */
function SitePermissions() {
  const browser = window.apexDeck?.browser;
  const [rows, setRows] = useState<{ origin: string; kind: string; allowed: boolean }[]>([]);
  useEffect(() => { void browser?.sitePermissions().then(setRows).catch(() => {}); }, [browser]);
  if (!rows.length) return null;
  return <div className="settings-card">
    {rows.map((row) => <Row key={`${row.origin} ${row.kind}`} id={`site-${row.origin}-${row.kind}`} label={row.origin} note={`${row.kind === "camera" ? "Camera" : "Microphone"}: ${row.allowed ? "allowed" : "denied"}`}>
      <button type="button" onClick={() => void browser?.forgetSitePermission(row.origin, row.kind).then(() => setRows((all) => all.filter((other) => other !== row)))}>Remove</button>
    </Row>)}
  </div>;
}

function General({ settings, onChange, backend: _backend, updates: _updates, onRestartToUpdate: _onRestart, onSection }: { settings: AppSettings; onChange: (s: AppSettings)=>void; backend: Backend; updates: UpdateStatus | null; onRestartToUpdate?: ()=>void; onSection: (s: SettingsSection)=>void }) {
  void _backend; void _updates; void _onRestart;
  const [autoOpen, setAutoOpen] = useState(artifactAutoOpen);
  return <>
    <SitePermissions />
    <div className="settings-card">
      <Row id="user-name" label="Name" note="Optional. Your bots see this in every thread on this machine.">
        <input aria-label="Name" maxLength={60} value={settings.userName} onChange={e=>onChange({ ...settings, userName: e.target.value })} />
      </Row>
      <Row id="user-nickname" label="What agents should call you" note={'Optional. Used in plans and group chats. Left empty, they use your name, or "the user".'}>
        <input aria-label="What agents should call you" maxLength={60} value={settings.userNickname} onChange={e=>onChange({ ...settings, userNickname: e.target.value })} />
      </Row>
    </div>
    <div className="settings-card">
      <Row id="artifacts" label="New artifacts" note="When a bot writes a file, the artifacts pane can show.">
        <select aria-label="New artifacts" value={autoOpen ? "open" : "notify"} onChange={(e)=>{ const on=e.target.value==='open'; setArtifactAutoOpen(on); setAutoOpen(on); }}>
          <option value="open">Open the pane</option>
          <option value="notify">Just notify</option>
        </select>
      </Row>
      <Row id="run-buttons" label="Run buttons on code blocks" note="Shell blocks in a bot's reply get a Run button. Clicking it runs the block in the thread's folder on the thread's host.">
        <input type="checkbox" aria-label="Run buttons on code blocks" checked={settings.codeRunButtons} onChange={e=>onChange({ ...settings, codeRunButtons: e.target.checked })} />
      </Row>
    </div>
    <div className="section-title">Looking for something else?</div>
    <div className="settings-card">
      <Row label="Voice & call settings" note="All voice choices live in one place."><button className="link-btn" onClick={()=>onSection('calls')}>Open Calls</button></Row>
      <Row label="Saved work & storage" note="Locations, older records and maintenance."><button className="link-btn" onClick={()=>onSection('data')}>Open Data & storage</button></Row>
      <Row label="Appearance mode" note="Light, Dark or follow the system, plus theme and presets."><button className="link-btn" onClick={()=>onSection('appearance')}>Open Appearance</button></Row>
    </div>
  </>;
}

function HostsSection({ backend }: { backend: Backend }) {
  if (!backend.hosts) return null;
  return <>
    <div className="settings-card" id="connections"><HostsSettings backend={backend} hosts={backend.hosts} /></div>
    <Advanced title="Connection details & diagnostics" id="computer-edit"><p className="settings-note">Raw SSH diagnostics are shown per-host in the list above. Use Retry after checking key and username.</p></Advanced>
  </>;
}

function PhonesSection({ backend: _backend }: { backend: Backend }) {
  const backend = _backend;
  return <>
    <div className="settings-card" id="paired"><PhonesSettings backend={backend} /></div>
    <Advanced title="Connectivity & device details" id="phone-remote">
      <Row label="Remote connections" note="Paired phones can reach this Mac while it is online." id="phone-remote">
        <span className="pill">Managed in Phones settings above</span>
      </Row>
    </Advanced>
    <Advanced title="Device access & network settings" id="phone-tier"><p className="settings-note">Access tier and revoke controls live in the Phones list. Network endpoint ID, UDP port, and advertised addresses are shown there when available.</p></Advanced>
  </>;
}

function ComputerSection({ backend, highlightId }: { backend: Backend; highlightId: string | null }) {
  return <>
    <div className={highlightId==='ucu-enable' || highlightId==='ucu-status' ? 'search-highlight' : ''} id="ucu-enable"><ComputerUseSettings backend={backend} /></div>
    <Advanced title="Access, status & recovery" id="thread-grants"><p className="settings-note">Thread grants and revoke actions are managed in Unified Computer Use. Global enabled state, permissions, thread approval/revocation, and cursor preferences are kept up front.</p></Advanced>
    <Advanced title="Mac permissions & privacy" id="ucu-stop"><p className="settings-note">Privacy: granted app content goes to the model you chose. Only approved apps are shared. Stop ends current access.</p></Advanced>
  </>;
}

function GatewaySection({ backend, highlightId }: { backend: Backend; highlightId: string | null }) {
  return <div className={highlightId?.startsWith('gateway') ? 'search-highlight' : ''} id="gateway-endpoint"><ModelGatewaySettings backend={backend} /></div>;
}

function ExtensionsSection({ backend, highlightId }: { backend: Backend; highlightId: string | null }) {
  return <div className={highlightId?.startsWith('extension') ? 'search-highlight' : ''} id="extension-list"><ModsSettings backend={backend} /></div>;
}

function DataSection({ backend }: { backend: Backend; settings: AppSettings; onChange: (s:AppSettings)=>void; onSection: (s:SettingsSection)=>void }) {
  const [folder, setFolder] = useState("");
  const [remembered, setRemembered] = useState(()=>Object.values(rememberedModels()).filter((list)=>Array.isArray(list) && list.length>0).length);
  const [importing, setImporting] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{ backend.dataFolder().then(setFolder, ()=>setFolder("")); }, []);
  return <>
    <div className="settings-card" id="storage-location">
      <Row id="storage" label="Saved work location" note="Your chats, projects and local settings.">
        <span className="mono small" style={{maxWidth:380,overflow:'hidden',textOverflow:'ellipsis'}}>{folder || "…"}</span>
        {!backend.demo && <button disabled={!folder} onClick={()=>backend.openTarget(folder,null,false).catch(()=>{})}>Show in Finder</button>}
      </Row>
      <Row id="older-records" label="Older records / Review import" note="Tasks, conversations, group chats and assistants saved before this machine kept them safely. Nothing changes until you import, and the originals stay put.">
        <button onClick={()=>setImporting(true)}>Review…</button>
      </Row>
      {importing && <LegacyImportPanel backend={backend} startOpen onClose={()=>setImporting(false)} />}
    </div>
    <Advanced title="Maintenance" id="maintenance" defaultOpen>
      <Row id="remembered" label="Remembered models" note={remembered===0 ? "None yet. Model names you type in the bot form are offered again next time." : `Model names from ${remembered} ${remembered===1 ? "provider" : "providers"}, offered again in the bot form.`}>
        <button disabled={remembered===0} onClick={()=>{ forgetModels(); setRemembered(0); }}>Clear suggestions</button>
      </Row>
      <p className="settings-note">Keys and paired devices are managed in their own settings. Thread defaults are in New threads, chip styling in Appearance.</p>
    </Advanced>
  </>;
}

function AboutSection({ updates, onRestartToUpdate, highlightId }: { backend: Backend; updates: UpdateStatus | null; onRestartToUpdate?: ()=>void; highlightId: string | null }) {
  return <>
    <div className={`settings-card ${highlightId==='updates' ? 'search-highlight' : ''}`} id="updates">
      {updates ? <VersionRow updates={updates} onRestart={onRestartToUpdate} /> : <Row label="Version" note={`Apex Deck ${typeof __APP_VERSION__!=='undefined' ? __APP_VERSION__ : ''}`} />}
    </div>
    <Advanced title="Build details & diagnostics" id="build-details"><p className="settings-note">Local test builds and diagnostics are shown here when available. Update actions are truthful to the installed artifact.</p></Advanced>
  </>;
}

function VersionRow({ updates, onRestart, compact }: { updates: UpdateStatus; onRestart?: ()=>void; compact?: boolean }) {
  const [now, setNow] = useState(()=>Date.now());
  useEffect(()=>{ const t=setInterval(()=>setNow(Date.now()),60000); return ()=>clearInterval(t); }, []);
  const working = ["checking","downloading","verifying","installing"].includes(updates.state);
  return <Row label={compact ? "Version" : "Apex Deck"} note={<span role="status">{updateNote(updates, now)}</span>}>
    {updates.state==="ready" && onRestart ? <button className="primary" onClick={onRestart}>Restart to update</button> : updates.state!=="disabled" && <button disabled={working} onClick={()=>void updateActions.check()}>{updates.state==="checking" ? "Checking…" : "Check now"}</button>}
  </Row>;
}

const IMAGE_KEYS = [{ name: "OPENAI_API_KEY", image: "chatgpt" }, { name: "XAI_API_KEY", image: "grok" }, { name: "VENICE_API_KEY", image: "venice" }];
const KEY_STATE_LABEL: Record<KeyState, string> = { saved: "Saved", environment: "From environment", missing: "Missing" };

function usageNote(agents: number, image?: string) {
  const parts = [];
  if (agents>0) parts.push(`Used by ${agents} saved ${agents===1 ? "agent" : "agents"}`);
  if (image) parts.push(`Used by /image ${image}`);
  return parts.length>0 ? `${parts.join(". ")}.` : "Not used by a saved agent yet.";
}

function KeyRow({ name, note, state, backend, onChanged }: { name: string; note: string; state?: KeyState; backend: Backend; onChanged: ()=>void }) {
  const [editing,setEditing]=useState(false);
  const [draft,setDraft]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const fail=(e:unknown)=>setError(e instanceof Error ? e.message : String(e));
  const save=async()=>{
    const value=draft.trim(); if(!value||busy) return;
    setDraft(""); setBusy(true); setError("");
    try{ await backend.apiKeySave(name,value); setEditing(false); onChanged(); } catch(e){ fail(e); } finally{ setBusy(false); }
  };
  const remove=async()=>{
    setBusy(true); setError("");
    try{ await backend.apiKeyRemove(name); onChanged(); } catch(e){ fail(e); } finally{ setBusy(false); }
  };
  return <>
    <Row label={name} note={error || note}>
      {!backend.demo && state && <span className={state==="missing" ? "key-state missing" : "key-state found"}><span className="dot" aria-hidden="true"/>{KEY_STATE_LABEL[state]}</span>}
      {!editing && <button className="ghost" disabled={busy} onClick={()=>{ setError(""); setEditing(true); }}>{state==="saved" || state==="environment" ? "Replace" : "Add key"}</button>}
      {state==="saved" && !editing && <button className="ghost" disabled={busy} onClick={remove}>Remove</button>}
    </Row>
    {editing && <Row label="New key" note="Enter saves. Deck never shows it again.">
      <input type="password" aria-label={`${name} value`} autoComplete="off" spellCheck={false} disabled={busy} value={draft} autoFocus onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter"){ e.preventDefault(); save(); } else if(e.key==="Escape"){ setDraft(""); setEditing(false); } }} />
      <button disabled={!draft.trim()||busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      <button className="ghost" disabled={busy} onClick={()=>{ setDraft(""); setEditing(false); }}>Cancel</button>
    </Row>}
  </>;
}

const EXTRAS = [
  { key: "deepseek", label: "DeepSeek", detail: "DeepSeek API models" },
  { key: "ollama", label: "Ollama", detail: "Local models" },
  { key: "api", label: "Other API", detail: "OpenAI-compatible servers" },
  { key: "command", label: "Custom command", detail: "Your own command-line bot" },
  { key: "scripted", label: "Scripted", detail: "Offline testing" },
];

function ProvidersSection({ settings, onChange, agents, profiles, backend, highlightId }: { settings: AppSettings; onChange: (s:AppSettings)=>void; agents: AgentInfo[]; profiles: ParticipantConfig[]; backend: Backend; highlightId: string | null }) {
  const disabled=settings.disabledProviders;
  const setDisabled=(next:string[])=>onChange({ ...settings, disabledProviders: next });
  const rows=[...agents.map(a=>({ key:a.key, label:a.label, detail: a.found ? a.program : "Not installed" })), ...EXTRAS];
  const uses=useMemo(()=>{
    const map=new Map<string,{ agents:number; image?:string }>();
    for(const k of keyNamesIn(profiles)) map.set(k.name,{ agents:k.uses });
    for(const {name,image} of IMAGE_KEYS) map.set(name,{ agents: map.get(name)?.agents ?? 0, image });
    return map;
  },[profiles]);
  const names=useMemo(()=>[...uses.keys()].sort((a,b)=>a.localeCompare(b)),[uses]);
  const [states,setStates]=useState<Record<string,KeyState>>({});
  const refresh=useCallback(()=>{
    if(names.length===0){ setStates({}); return; }
    backend.apiKeyStatus(names).then(list=>setStates(Object.fromEntries(names.map((n,i)=>[n,list[i]]))), ()=>setStates({}));
  },[backend,names]);
  useEffect(()=>{ refresh(); },[refresh]);
  return <>
    <div className="settings-subhead"><h3>Visibility in bot creation</h3><p>Choose which tools appear when adding terminals and bots. Existing chats and terminals keep working.</p></div>
    <div className={`settings-card provider-grid ${highlightId?.includes('provider') ? 'search-highlight' : ''}`} id="provider-list">
      {rows.map(row=><label key={row.key} className="provider-toggle">
        <input type="checkbox" checked={providerEnabled(row.key, disabled)} onChange={e=>setDisabled(e.target.checked ? disabled.filter(id=>id!==row.key) : [...disabled, row.key])} />
        <span><strong>{row.label}</strong><small>{row.detail}</small></span>
      </label>)}
    </div>
    <div className="settings-actions">
      <button className="ghost" onClick={()=>setDisabled([])}>Enable all</button>
      <button className="ghost" onClick={()=>setDisabled([...new Set([...disabled, ...agents.filter(a=>!a.found).map(a=>a.key)])])}>Hide uninstalled tools</button>
      <span>Installed vs hidden is about the creation menu, not whether a saved bot still runs.</span>
    </div>
    <Advanced title="All tools & provider visibility" id="all-tools">
      <p className="settings-note">All 14 provider/tool categories are listed above. Hidden items stay usable in existing chats.</p>
    </Advanced>
    <div className="settings-subhead"><h3>Provider credentials</h3><p>Keys your bots and /image use. Saved in this Mac's Keychain, or a private file on Linux servers. Deck never shows a saved key again.</p></div>
    <div className={`settings-card ${highlightId==='api-key' ? 'search-highlight' : ''}`} id="api-key">
      {names.map(name=><KeyRow key={name} name={name} note={usageNote(uses.get(name)?.agents ?? 0, uses.get(name)?.image)} state={states[name]} backend={backend} onChanged={refresh} />)}
      {names.length===0 && <Row label="No API keys referenced yet" note="Add an OpenAI-compatible provider or use a saved agent that references an API key env var." />}
    </div>
  </>;
}

function ThreadsSection({ settings, onChange, highlightId }: { settings: AppSettings; onChange: (s:AppSettings)=>void; highlightId: string | null }) {
  const thread=settings.newThread;
  return <div className="settings-card">
    <Row id="answers" label="Who answers" note="Who replies to your message." highlight={highlightId==='answers'}>
      <select aria-label="Who answers" value={thread.policy} onChange={e=>onChange({ ...settings, newThread: { ...thread, policy: e.target.value as TurnPolicy } })}>
        <option value="mention">Whoever I addressed last</option>
        <option value="everyone">Everyone at once</option>
        <option value="round_robin">Everyone in turn</option>
      </select>
    </Row>
    <Row id="rounds" label="Model-to-model rounds" note="How many times bots may answer each other after one of your messages. Step past 10 for unlimited (∞), which runs until you press Stop." highlight={highlightId==='rounds'}>
      <span className="stepper">
        <button type="button" aria-label="Less rounds" disabled={thread.max_bot_hops!==null && thread.max_bot_hops<=0} onClick={()=>onChange({ ...settings, newThread: { ...thread, max_bot_hops: thread.max_bot_hops===null ? MAX_ROUNDS : thread.max_bot_hops-1 } })}>−</button>
        <output aria-label="rounds">{thread.max_bot_hops ?? "∞"}</output>
        <button type="button" aria-label="More rounds" disabled={thread.max_bot_hops===null} onClick={()=>onChange({ ...settings, newThread: { ...thread, max_bot_hops: thread.max_bot_hops!==null && thread.max_bot_hops>=MAX_ROUNDS ? null : (thread.max_bot_hops ?? 0)+1 } })}>+</button>
      </span>
    </Row>
    <Row id="access" label="Access for new bots" note="Ask first only works with tools that can enforce it. Others start at Read only." highlight={highlightId==='access'}>
      <select aria-label="Access for new bots" value={settings.newBotAccess} onChange={e=>onChange({ ...settings, newBotAccess: e.target.value as Access })}>
        <option value="read">Read only</option>
        <option value="ask">Ask first</option>
        <option value="edits">Can edit files</option>
        <option value="full">Full access</option>
      </select>
    </Row>
    <Row id="steer" label="Confirm before steering" note="Steering stops a bot mid-turn. Threads can override this in Thread details." highlight={highlightId==='steer'}>
      <input type="checkbox" aria-label="Confirm before steering" checked={settings.confirmSteer} onChange={e=>onChange({ ...settings, confirmSteer: e.target.checked })} />
    </Row>
    <p className="settings-note">Existing threads keep their own settings. Agent chip styling moved to Appearance since it affects current chats too.</p>
  </div>;
}

function TerminalSection({ settings, onChange, highlightId }: { settings: AppSettings; onChange: (s:AppSettings)=>void; highlightId: string | null }) {
  const terminal=settings.terminal;
  const set=(next: Partial<AppSettings["terminal"]>)=>onChange({ ...settings, terminal: { ...terminal, ...next } });
  return <>
    <div className="settings-card">
      <Row id="terminal-font" label="Font size" highlight={highlightId==='terminal-font'}>
        <Stepper label="font size" unit="px" value={terminal.fontSize} min={FONT_SIZES.min} max={FONT_SIZES.max} onChange={n=>set({ fontSize: n })} />
      </Row>
      <Row id="scrollback" label="Scrollback" note="Lines each terminal keeps above the screen." highlight={highlightId==='scrollback'}>
        <select aria-label="Scrollback" value={terminal.scrollback} onChange={e=>set({ scrollback: Number(e.target.value) })}>
          {SCROLLBACK_CHOICES.map(n=><option key={n} value={n}>{n.toLocaleString("en-US")} lines</option>)}
        </select>
      </Row>
    </div>
    <div className="terminal-sample" style={{ fontSize: terminal.fontSize }} aria-hidden="true">
      <div className="muted">~/apex-deck</div>
      <div><span className="prompt">❯</span> npm test</div>
      <div className="muted">Tests  256 passed (256)</div>
    </div>
  </>;
}

function CallsSection({ settings, onChange, backend, highlightId }: { settings: AppSettings; onChange: (s:AppSettings)=>void; backend: Backend; highlightId: string | null }) {
  const voice=readVoiceSettings(settings.voice);
  const [keyState,setKeyState]=useState<KeyState|null>(null);
  const [metaKeyState,setMetaKeyState]=useState<KeyState|null>(null);
  const [draft,setDraft]=useState("");
  const [draftKey,setDraftKey]=useState<"OPENAI_API_KEY"|"META_API_KEY">("OPENAI_API_KEY");
  const [editing,setEditing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState("");
  const refreshKeys=useCallback(()=>{
    backend.apiKeyStatus(["OPENAI_API_KEY"]).then(list=>setKeyState(list[0]), ()=>setKeyState(null));
    backend.apiKeyStatus(["META_API_KEY"]).then(list=>setMetaKeyState(list[0]), ()=>setMetaKeyState(null));
  },[backend]);
  useEffect(()=>{ refreshKeys(); },[refreshKeys]);
  const canRealtime=keyState==="saved" || keyState==="environment";
  const canMeta=metaKeyState==="saved" || metaKeyState==="environment";
  const setEngine=(engine:"local"|"realtime"|"meta")=>onChange({ ...settings, voice: { ...voice, engine } });
  const setRealtimeVoice=(v:string)=>onChange({ ...settings, voice: { ...voice, realtimeVoice: v } });
  const saveKey=async()=>{
    const v=draft.trim(); if(!v||busy) return;
    setBusy(true); setErr("");
    try{ await backend.apiKeySave(draftKey,v); setDraft(""); setEditing(false); refreshKeys(); } catch(e){ setErr(e instanceof Error ? e.message : String(e)); } finally{ setBusy(false); }
  };
  const removeKey=async(keyName:"OPENAI_API_KEY"|"META_API_KEY")=>{
    setBusy(true); setErr("");
    try{ await backend.apiKeyRemove(keyName); refreshKeys(); } catch(e){ setErr(e instanceof Error ? e.message : String(e)); } finally{ setBusy(false); }
  };
  return <div className="settings-card">
    <Row id="engine" label="Call engine" note={"Local uses Whisper+Kokoro on this Mac. GPT-Live uses OpenAI Realtime. Meta Voice uses Meta transcription + Kokoro TTS."} highlight={highlightId==='engine'}>
      <span className="voice-seg" role="group" aria-label="Call engine">
        <button type="button" aria-pressed={voice.engine==="local"} onClick={()=>setEngine("local")}>Local</button>
        <button type="button" aria-pressed={voice.engine==="realtime"} disabled={!canRealtime} title={!canRealtime ? "Add an OpenAI key first" : undefined} onClick={()=>setEngine("realtime")}>GPT-Live</button>
        <button type="button" aria-pressed={voice.engine==="meta"} disabled={!canMeta} title={!canMeta ? "Add a Meta API key first" : undefined} onClick={()=>setEngine("meta")}>Meta Voice</button>
      </span>
    </Row>
    {voice.engine==="realtime" && <Row id="live-voice" label="GPT-Live voice" note="Voice GPT-Live speaks with (OpenAI realtime voices)." highlight={highlightId==='live-voice'}>
      <select aria-label="GPT-Live voice" value={voice.realtimeVoice ?? DEFAULT_REALTIME_VOICE} onChange={e=>setRealtimeVoice(e.target.value)}>
        {REALTIME_VOICES.map(v=><option key={v} value={v}>{realtimeVoiceLabel(v)}</option>)}
      </select>
    </Row>}
    {voice.engine==="realtime" && <Row label="GPT-Live model" note="OpenAI realtime model. Applies next call.">
      <select aria-label="GPT-Live model" value={voice.realtimeModel ?? DEFAULT_REALTIME_MODEL} onChange={e=>onChange({ ...settings, voice: { ...voice, realtimeModel: e.target.value } })}>
        {REALTIME_MODELS.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </Row>}
    {voice.engine==="meta" && <Row label="Meta model" note="Meta Voice Transcribe model. Applies next call.">
      <select aria-label="Meta model" value={voice.metaModel ?? DEFAULT_META_MODEL} onChange={e=>onChange({ ...settings, voice: { ...voice, metaModel: e.target.value } })}>
        {META_MODELS.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </Row>}
    <Row id="api-key-call" label="OpenAI API key" note={err && draftKey==="OPENAI_API_KEY" ? err : (keyState ? KEY_STATE_LABEL[keyState] + (keyState==="environment" ? " – remove from shell to replace here." : "") + (keyState!=="missing" ? " Key never shown; only a short-lived token reaches the call." : " Needed for GPT-Live.") : "Checking…")} highlight={highlightId==='api-key' || highlightId==='key-1'}>
      {!editing && <>
        <button className="ghost" disabled={busy} onClick={()=>{ setErr(""); setDraftKey("OPENAI_API_KEY"); setEditing(true); }}>{keyState==="saved" || keyState==="environment" ? "Replace" : "Add key"}</button>
        {keyState==="saved" && <button className="ghost" disabled={busy} onClick={()=>removeKey("OPENAI_API_KEY")}>Remove</button>}
      </>}
    </Row>
    <Row id="api-key-meta" label="Meta API key" note={err && draftKey==="META_API_KEY" ? err : (metaKeyState ? KEY_STATE_LABEL[metaKeyState] + (metaKeyState==="environment" ? " – remove from shell to replace here." : "") + (metaKeyState!=="missing" ? " Key for Meta Voice Transcribe. Stored in daemon." : " Needed for Meta Voice. Get at dev.meta.ai.") : "Checking…")} highlight={highlightId==='api-key-meta'}>
      {!editing && <>
        <button className="ghost" disabled={busy} onClick={()=>{ setErr(""); setDraftKey("META_API_KEY"); setEditing(true); }}>{metaKeyState==="saved" || metaKeyState==="environment" ? "Replace" : "Add key"}</button>
        {metaKeyState==="saved" && <button className="ghost" disabled={busy} onClick={()=>removeKey("META_API_KEY")}>Remove</button>}
      </>}
    </Row>
    {editing && <Row label={draftKey==="META_API_KEY" ? "New Meta key" : "New OpenAI key"} note="Enter saves. Deck never shows it again.">
      <input type="password" aria-label={`${draftKey} value`} autoComplete="off" spellCheck={false} disabled={busy} value={draft} autoFocus onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter"){ e.preventDefault(); saveKey(); } else if(e.key==="Escape"){ setDraft(""); setEditing(false); } }} />
      <button disabled={!draft.trim()||busy} onClick={saveKey}>{busy ? "Saving…" : "Save"}</button>
      <button className="ghost" disabled={busy} onClick={()=>{ setDraft(""); setEditing(false); }}>Cancel</button>
    </Row>}
    <Row id="voice" label="Default local voice" note="For agents with no voice of their own. Set one agent's voice in its form." highlight={highlightId==='voice'}>
      <span className="voice-pick">
        <select aria-label="Voice for calls" value={defaultVoiceOf(voice)} onChange={e=>onChange({ ...settings, voice: { ...voice, defaultVoice: e.target.value } })}>
          {[...new Set([defaultVoiceOf(voice), ...CALL_VOICES])].map(v=><option key={v} value={v}>{voiceLabel(v)}</option>)}
        </select>
        <VoiceSampleButton voice={defaultVoiceOf(voice)} />
      </span>
    </Row>
    <Row id="pause" label="Pause before reply" note="Silence before agent replies (local calls)." highlight={highlightId==='pause'}>
      <input type="range" min={300} max={2000} step={50} value={voice.silenceMs} onChange={e=>onChange({ ...settings, voice: { ...voice, silenceMs: e.target.valueAsNumber } })} />
      <span>{voice.silenceMs} ms</span>
    </Row>
    <Row id="call-controls" label="Call controls" note="How a running call shows. Applies to all chats, including pop-outs." highlight={highlightId==='call-controls'}>
      <span className="voice-seg" role="group" aria-label="Call controls">
        {CALL_LOOKS.map(l=><button type="button" key={l.id} aria-pressed={l.id===voice.look} onClick={()=>onChange({ ...settings, voice: { ...voice, look: l.id as any } })}>{l.label}</button>)}
      </span>
    </Row>
    {!canRealtime && <p className="settings-note">Get a key at platform.openai.com with Realtime access. The long-lived key stays in the daemon (Keychain); the renderer only ever gets an ephemeral client_secret.</p>}
    <p className="settings-note">Your Local and GPT-Live preferences are remembered separately. OpenAI key management now has one canonical location in Models & providers — this row links there.</p>
  </div>;
}

function ShortcutsSection({ highlightId }: { highlightId: string | null }) {
  const mac=/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const all=shortcutList(mac);
  const groups=[
    { title: 'Navigation', items: all.filter(s=>['Agents','Code','Threads','Open Assistant','Settings','Dashboard'].some(k=>s.label.includes(k))) },
    { title: 'Threads', items: all.filter(s=>['New thread','Next thing','Rename thread','Pin','Mark','Archive','Change thread project'].some(k=>s.label.includes(k))) },
    { title: 'Panes & composer', items: all.filter(s=>['pane','Maximize','Full-screen','terminal tool','Steer','New terminal'].some(k=>s.label.toLowerCase().includes(k.toLowerCase()))) },
  ];
  return <>
    {groups.map((g,i)=><div key={g.title}>
      <div className="section-title">{g.title}</div>
      <div className={`settings-card ${highlightId==='shortcut-list' && i===0 ? 'search-highlight' : ''}`} id={i===0 ? 'shortcut-list' : undefined}>
        {(g.items.length?g.items:all.slice(i*3,(i+1)*3)).map(s=><div key={s.label} className="settings-row compact"><span>{s.label}</span><kbd>{s.keys}</kbd></div>)}
      </div>
    </div>)}
    {!mac && <p className="settings-note">On macOS these use ⌘.</p>}
    <p className="settings-note">All existing shortcut actions are retained. Shortcut rebinding is outside this scope and remains honestly labeled as fixed.</p>
  </>;
}
