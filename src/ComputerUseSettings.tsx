import { nextSettingsSaveSequence } from "./settingsSaveSequence";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Backend } from './backend';

type CursorOverlayPrefs = {
  preset: 'default' | 'simple' | 'ring-only' | 'custom' | string;
  size: number;
  fill?: string | null;
  rim?: string | null;
  accent?: string | null;
  ripple: boolean;
  highlight: boolean;
  labelsEnabled: boolean;
  motion: {
    travelMinMs: number;
    travelMaxMs: number;
    dwellMs: number;
    bow: number;
    overshoot: number;
    tremor: number;
  };
  customImage?: { path: string; hotspotX: number; hotspotY: number } | null;
};

type ComputerStatus = {
  available: boolean;
  enabled: boolean;
  accessibilityTrusted?: boolean;
  listenEventAccess?: boolean;
  screenCaptureAccess?: boolean;
  stopped?: boolean;
  cursorOverlayLabelsEnabled?: boolean;
  /** Keep working while I'm away. Switched only from the helper's menu bar menu. */
  awayMode?: { enabled: boolean; holding: boolean; shielded: boolean; shieldDelaySeconds: number };
  cursorOverlay?: CursorOverlayPrefs;
  cursorOverlayFromHelper?: any;
  reason?: string;
};

const DEFAULT_PREFS: CursorOverlayPrefs = {
  preset: 'default',
  size: 1.0,
  fill: null,
  rim: '#111318',
  accent: '#4299FF',
  ripple: true,
  highlight: true,
  labelsEnabled: false,
  motion: { travelMinMs: 90, travelMaxMs: 320, dwellMs: 0, bow: 1.0, overshoot: 0.035, tremor: 1.1 },
  customImage: null,
};

function isHex(s: string) {
  const h = s.startsWith('#') ? s.slice(1) : s;
  return (h.length === 3 || h.length === 6) && /^[0-9a-fA-F]+$/.test(h);
}

function toHexColor(input: string | null | undefined, fallback: string) {
  if (!input) return fallback;
  return isHex(input) ? (input.startsWith('#') ? input : `#${input}`) : fallback;
}

export function ComputerUseSettings({ backend }: { backend: Backend }) {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [prefs, setPrefs] = useState<CursorOverlayPrefs>(DEFAULT_PREFS);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await backend.call<ComputerStatus>('computer_status');
      setStatus(s);
      // Prefer authoritative host cursorOverlay; offline prefs survive reconnect
      const p = s.cursorOverlay ?? (s.cursorOverlayFromHelper as CursorOverlayPrefs) ?? DEFAULT_PREFS;
      // normalize
      const merged: CursorOverlayPrefs = {
        ...DEFAULT_PREFS,
        ...p,
        motion: { ...DEFAULT_PREFS.motion, ...(p.motion ?? {}) },
        preset: (p.preset as any) ?? 'default',
        fill: p.fill ?? null,
        rim: p.rim ?? DEFAULT_PREFS.rim,
        accent: p.accent ?? DEFAULT_PREFS.accent,
        customImage: p.customImage ?? null,
        labelsEnabled: s.cursorOverlayLabelsEnabled ?? p.labelsEnabled ?? false,
      };
      setPrefs(merged);
      setError('');
    } catch {
      setError('Unified Computer Use is unavailable on this host. Update the desktop app and try again.');
    }
  }, [backend]);

  useEffect(() => {
    if (backend.demo) {
      setStatus({ available: false, enabled: false, reason: 'Available in the macOS desktop app.' });
      return;
    }
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [backend.demo, refresh]);

  const act = async (command: string, args?: Record<string, unknown>) => {
    const seq = nextSettingsSaveSequence();
    try { window.dispatchEvent(new CustomEvent('settings-save-pending', { detail: { seq, source: 'cursor' } })); } catch {}
    setBusy(true); setError('');
    try {
      const s = await backend.call<ComputerStatus>(command, args);
      setStatus(s);
      const p = s.cursorOverlay ?? (s.cursorOverlayFromHelper as CursorOverlayPrefs) ?? DEFAULT_PREFS;
      setPrefs({
        ...DEFAULT_PREFS,
        ...p,
        motion: { ...DEFAULT_PREFS.motion, ...(p.motion ?? {}) },
        preset: (p.preset as any) ?? prefs.preset,
        labelsEnabled: (s.cursorOverlayLabelsEnabled ?? p.labelsEnabled) as any ?? prefs.labelsEnabled,
      });
      try { window.dispatchEvent(new CustomEvent('settings-saved', { detail: { seq, source: 'cursor' } })); } catch {}
    } catch (e: any) {
      try { window.dispatchEvent(new CustomEvent('settings-save-error', { detail: { seq, source: 'cursor', error: e?.message } })); } catch {}
      setError(e?.message || 'The request could not finish. Open Unified Computer Use from the menu bar and check its status.');
    } finally { setBusy(false); }
  };

  const commitPrefs = async (next: CursorOverlayPrefs) => {
    const seq = nextSettingsSaveSequence();
    try { window.dispatchEvent(new CustomEvent('settings-save-pending', { detail: { seq, source: 'cursor' } })); } catch {}
    const prev = prefs;
    setPrefs(next);
    setBusy(true); setError('');
    try {
      const s = await backend.call<ComputerStatus>('computer_set_cursor_overlay', { prefs: next as any });
      setStatus(s);
      // Prefer authoritative host cursorOverlay; offline prefs survive reconnect
      const hp = s.cursorOverlay ?? (s.cursorOverlayFromHelper as CursorOverlayPrefs);
      if (hp) {
        setPrefs({
          ...DEFAULT_PREFS,
          ...hp,
          motion: { ...DEFAULT_PREFS.motion, ...(hp.motion ?? {}) },
          preset: (hp.preset as any) ?? next.preset,
          labelsEnabled: (s.cursorOverlayLabelsEnabled ?? hp.labelsEnabled) as any ?? next.labelsEnabled,
          customImage: (hp as any).customImage ?? next.customImage ?? null,
        });
      }
      try { window.dispatchEvent(new CustomEvent('settings-saved', { detail: { seq, source: 'cursor' } })); } catch {}
    } catch (e: any) {
      try { window.dispatchEvent(new CustomEvent('settings-save-error', { detail: { seq, source: 'cursor', error: e?.message } })); } catch {}
      setError(e?.message || 'Could not save cursor settings. Helper acknowledgement failed; host prefs kept but helper may be offline.');
      // rollback optimistic to previous validated state if save failed
      setPrefs(prev);
      // refresh status to get ground truth
      try { const s = await backend.call<ComputerStatus>('computer_status'); setStatus(s); } catch {}
    } finally { setBusy(false); }
  };

  const setActionLabels = async (enabled: boolean) => {
    setPrefs({ ...prefs, labelsEnabled: enabled });
    await act('computer_set_action_labels', { enabled });
  };

  const handlePreset = (preset: CursorOverlayPrefs['preset']) => {
    let next = { ...prefs, preset };
    if (preset === 'simple') next = { ...next, ripple: false, highlight: false };
    else if (preset === 'ring-only') next = { ...next, ripple: true, highlight: true, size: Math.max(next.size, 0.8) };
    else if (preset === 'default') next = { ...next, ripple: true, highlight: true };
    void commitPrefs(next);
  };

  const handleImage = async (file: File) => {
    if (!file.type.includes('png')) { setError('Custom cursor must be PNG.'); return; }
    if (file.size > 2 * 1024 * 1024) { setError('PNG must be ≤2 MiB (upstream limit).'); return; }
    // client-side dimension check
    const checkDim = await new Promise<{ w: number; h: number } | null>((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
      img.src = url;
    });
    if (!checkDim) { setError('Could not read PNG dimensions.'); return; }
    if (checkDim.w > 1024 || checkDim.h > 1024) { setError(`PNG must be ≤1024 per side (upstream limit). Got ${checkDim.w}×${checkDim.h}.`); return; }
    if (checkDim.w === 0 || checkDim.h === 0) { setError('PNG has zero size.'); return; }

    const base64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(file);
    });
    const seq = nextSettingsSaveSequence();
    try { window.dispatchEvent(new CustomEvent('settings-save-pending', { detail: { seq, source: 'cursor' } })); } catch {}
    setBusy(true); setError('');
    try {
      // Send only canonical key imageBase64 to prevent serde duplicate-field rejection
      const s = await backend.call<ComputerStatus>('computer_set_cursor_image', { imageBase64: base64 });
      setStatus(s);
      const hp = s.cursorOverlay ?? (s.cursorOverlayFromHelper as CursorOverlayPrefs);
      if (hp) {
        setPrefs({
          ...DEFAULT_PREFS,
          ...hp,
          motion: { ...DEFAULT_PREFS.motion, ...(hp.motion ?? {}) },
          preset: (hp.preset as any) ?? 'custom',
          labelsEnabled: (s.cursorOverlayLabelsEnabled ?? hp.labelsEnabled) as any ?? prefs.labelsEnabled,
        });
      } else {
        setPrefs(prev => ({ ...prev, preset: 'custom' }));
      }
      try { window.dispatchEvent(new CustomEvent('settings-saved', { detail: { seq, source: 'cursor' } })); } catch {}
    } catch (e: any) {
      try { window.dispatchEvent(new CustomEvent('settings-save-error', { detail: { seq, source: 'cursor', error: e?.message } })); } catch {}
      setError(e?.message || 'Could not save custom cursor. Falls back to built-in.');
    } finally { setBusy(false); }
  };

  const permission = (value: boolean | undefined) => value === true ? 'Allowed' : value === false ? 'Not allowed' : 'Open the helper to check';

  const previewStyle: React.CSSProperties = {
    width: 18 + prefs.size * 8,
    height: 18 + prefs.size * 8,
    background: prefs.fill || prefs.accent || '#4299FF',
    border: `2px solid ${prefs.rim || '#111318'}`,
    borderRadius: prefs.preset === 'simple' ? 0 : 2,
    boxShadow: prefs.ripple ? `0 0 0 3px ${prefs.accent || '#4299FF'}33` : 'none',
    display: 'inline-block',
  };

  return <>
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-label"><strong>Enable Unified Computer Use</strong><small>Let supported bots request access to Mac apps. Each app needs your permission before a bot can read or control it.</small></div>
        <input type="checkbox" aria-label="Enable Unified Computer Use" checked={status?.enabled ?? false} disabled={busy || backend.demo || !status?.available} onChange={e => { void act('computer_set_enabled', { enabled: e.target.checked }); }} />
      </div>
      <div className="settings-row">
        <div className="settings-label"><strong>Status</strong><small role="status">{backend.demo ? 'Available in the macOS desktop app.' : !status ? 'Checking this host…' : !status.available ? status.reason || 'The bundled helper is unavailable on this host.' : !status.enabled ? 'Off' : status.stopped ? 'Stopped. Resume, then send a new message to begin a new turn.' : 'Ready for app requests'}</small></div>
        {status?.enabled && status.stopped ? <button disabled={busy || backend.demo} onClick={() => { void act('computer_set_enabled', { enabled: true }); }}>Resume</button> : <button disabled={busy || backend.demo} onClick={() => { void refresh(); }}>Refresh</button>}
      </div>
      <div className="settings-row">
        <div className="settings-label"><strong>Mac permissions</strong><small>Accessibility: {permission(status?.accessibilityTrusted)}<br />Input Monitoring: {permission(status?.listenEventAccess)}<br />Screen Recording: {permission(status?.screenCaptureAccess)}</small></div>
        <button disabled={busy || backend.demo || !status?.available} onClick={() => { void act('computer_setup'); }}>Open Unified Computer Use</button>
      </div>
    </div>

    <div className="section-title">Cursor indicator</div>
    <div className="settings-card" id="cursor">
      <div className="settings-row">
        <div className="settings-label"><strong>Cursor style</strong><small>Visual overlay only — does not change your OS mouse. Click ring only displays click ripple and highlight rings without drawing an arrow pointer.</small></div>
        <div className="inline-options" role="group" aria-label="Cursor preset">
          <button aria-pressed={prefs.preset==='default'} onClick={()=>handlePreset('default')} disabled={busy}>Default</button>
          <button aria-pressed={prefs.preset==='simple'} onClick={()=>handlePreset('simple')} disabled={busy}>Simple pointer</button>
          <button aria-pressed={prefs.preset==='ring-only'} onClick={()=>handlePreset('ring-only')} disabled={busy} title="Displays click ripple and highlight rings without drawing an arrow pointer">Click ring only</button>
          <button aria-pressed={prefs.preset==='custom'} onClick={()=>handlePreset('custom')} disabled={busy}>Custom image</button>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-label"><strong>Preview</strong><small><span style={previewStyle} aria-hidden="true" /> <span style={{ marginLeft: 8 }}>{prefs.size.toFixed(1)}× · {prefs.accent} · {prefs.preset}</span>{prefs.customImage && <><br />Custom: {prefs.customImage.path.split('/').pop()}</>}</small></div>
        <div className="settings-label"><strong>Size</strong><small>Upstream range {0.5}–{4.0}</small></div>
        <input type="range" min={0.5} max={4.0} step={0.1} value={prefs.size} disabled={busy} onChange={e=>{ const v=parseFloat(e.target.value); void commitPrefs({ ...prefs, size: v }); }} />
      </div>

      <div className="settings-row">
        <div className="settings-label"><strong>Colors</strong><small>Fill (body) falls back to accent. Upstream validates hex #FFF or #FFFFFF.</small></div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <label>Fill <input type="color" value={toHexColor(prefs.fill, '#ffffff')} disabled={busy} onChange={e=>void commitPrefs({ ...prefs, fill: e.target.value })} /></label>
          <label>Accent <input type="color" value={toHexColor(prefs.accent, '#4299ff')} disabled={busy} onChange={e=>void commitPrefs({ ...prefs, accent: e.target.value })} /></label>
          <label>Rim/outline <input type="color" value={toHexColor(prefs.rim, '#111318')} disabled={busy} onChange={e=>void commitPrefs({ ...prefs, rim: e.target.value })} /></label>
          <button disabled={busy} onClick={()=>void commitPrefs({ ...prefs, fill: null, rim: '#111318', accent: '#4299FF' })}>Reset colors</button>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-label"><strong>Effects</strong><small>Ripple on click, target highlight box.</small></div>
        <div style={{ display: 'flex', gap: 16 }}>
          <label><input type="checkbox" checked={prefs.ripple} disabled={busy} onChange={e=>void commitPrefs({ ...prefs, ripple: e.target.checked })} /> Ripple</label>
          <label><input type="checkbox" checked={prefs.highlight} disabled={busy} onChange={e=>void commitPrefs({ ...prefs, highlight: e.target.checked })} /> Target highlight</label>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-label"><strong>Show action labels</strong><small>Optional description beside cursor. Off by default; pointer and ripple remain.</small></div>
        <input type="checkbox" aria-label="Show action labels" checked={prefs.labelsEnabled} disabled={busy || backend.demo || !status?.available} onChange={e => { void setActionLabels(e.target.checked); }} />
      </div>

      <div className="settings-row">
        <div className="settings-label"><strong>Custom PNG cursor</strong><small>PNG, ≤2 MiB, ≤1024 per side (upstream limits). Stored in app data / computer-cursor/, not temp path. Degrades to default if missing.</small></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input ref={fileRef} type="file" accept=".png,image/png" style={{ display: 'none' }} onChange={e=>{ const f=e.target.files?.[0]; if (f) void handleImage(f); if (fileRef.current) fileRef.current.value=''; }} />
          <button disabled={busy} onClick={()=>fileRef.current?.click()}>Choose PNG…</button>
          {prefs.customImage && <button disabled={busy} onClick={()=>void commitPrefs({ ...prefs, customImage: null, preset: 'default' })}>Clear image</button>}
          <button disabled={busy} onClick={()=>void act('computer_reset_cursor_overlay', {})}>Reset to default</button>
        </div>
      </div>

      <details open={customOpen} onToggle={e=>setCustomOpen((e.target as HTMLDetailsElement).open)} className="settings-advanced" id="cursor-customize">
        <summary>Customize cursor — motion & dwell</summary>
        <div className="advanced-body">
          <div className="settings-row">
            <div className="settings-label"><strong>Linger timing</strong><small>How long the overlay lingers after an action lands (0–300 ms).</small></div>
            <div style={{ display: 'grid', gap: 8 }}>
              <label>Dwell ms <input type="range" min={0} max={300} step={5} value={prefs.motion.dwellMs} disabled={busy} onChange={e=>void commitPrefs({ ...prefs, motion: { ...prefs.motion, dwellMs: parseInt(e.target.value) } })} /> <output>{prefs.motion.dwellMs} ms</output></label>
            </div>
          </div>
          <div className="settings-row" style={{ opacity: 0.65 }}>
            <div className="settings-label"><strong>Travel timing (unavailable in landing-only overlay)</strong><small>Travel path animation across the screen is not active in the landing-only overlay; the indicator displays directly at the action point.</small></div>
            <div style={{ display: 'grid', gap: 8 }}>
              <label>Travel min ms <input type="range" min={30} max={320} step={5} value={prefs.motion.travelMinMs} disabled={true} title="Unavailable in landing-only overlay" /> <output>{prefs.motion.travelMinMs} ms</output></label>
              <label>Travel max ms <input type="range" min={30} max={600} step={5} value={prefs.motion.travelMaxMs} disabled={true} title="Unavailable in landing-only overlay" /> <output>{prefs.motion.travelMaxMs} ms</output></label>
            </div>
          </div>
          <div className="settings-row" style={{ opacity: 0.65 }}>
            <div className="settings-label"><strong>Path shape (unavailable in landing-only overlay)</strong><small>Trajectory curve, overshoot, and tremor are not active in the landing-only overlay.</small></div>
            <div style={{ display: 'grid', gap: 8 }}>
              <label>Bow <input type="range" min={0} max={3} step={0.1} value={prefs.motion.bow} disabled={true} title="Unavailable in landing-only overlay" /> <output>{prefs.motion.bow.toFixed(1)}</output></label>
              <label>Overshoot <input type="range" min={0} max={0.15} step={0.005} value={prefs.motion.overshoot} disabled={true} title="Unavailable in landing-only overlay" /> <output>{prefs.motion.overshoot.toFixed(3)}</output></label>
              <label>Tremor <input type="range" min={0} max={4} step={0.1} value={prefs.motion.tremor} disabled={true} title="Unavailable in landing-only overlay" /> <output>{prefs.motion.tremor.toFixed(1)}</output></label>
            </div>
          </div>
          <p className="settings-note">Note: The overlay indicator displays directly at the action coordinates with spring pop, pulse, and ripple animations. Travel path tracing across the screen is not rendered. Dwell ms controls how long the indicator lingers before fading.</p>
        </div>
      </details>
    </div>

    <div className="settings-card">
      <div className="settings-row" id="ucu-away"><div className="settings-label"><strong>Keep working while I&rsquo;m away</strong><small>{status?.awayMode?.enabled
        ? `On. While an untethered bot works, this Mac won't idle-lock. After ${Math.round((status.awayMode.shieldDelaySeconds || 300) / 60)} minutes without input a shield covers the screens, and any keyboard or mouse input locks the Mac.${status.awayMode.shielded ? ' Shield is up now.' : status.awayMode.holding ? ' Holding the Mac awake now.' : ''}`
        : 'Off. Untethered bots stop when this Mac locks. Turn it on from the Unified Computer Use menu bar icon; it can’t be switched on remotely.'}</small></div></div>
      <div className="settings-row">
        <div className="settings-label"><strong>Stop Unified Computer Use</strong><small>Cancels active input and revokes current turns. The helper also has an independent Stop control in the menu bar.</small></div>
        <button className="danger" disabled={busy || backend.demo || !status?.available} onClick={() => { void act('computer_stop'); }}>Stop</button>
      </div>
    </div>

    <div className="settings-card">
      <div className="settings-row"><div className="settings-label"><strong>Models and screenshots</strong><small>Use your existing API, Claude Code or Codex bot in a Work thread. Enable screenshot support in an API bot’s settings only when its model accepts images.</small></div></div>
      <div className="settings-row"><div className="settings-label"><strong>Text-only models</strong><small>This model can’t read screenshots and relies on accessibility text. Some controls may be missing or interpreted incorrectly, making computer use less reliable.</small></div></div>
      <div className="settings-row"><div className="settings-label"><strong>Privacy</strong><small>Granted app content goes to the model you chose, including its cloud provider. Deck hides computer tool content from its work feed and diagnostics. Providers, CLI transcripts and a bot’s own replies may retain content. Only one bot controls the desktop at a time; using your mouse or keyboard interrupts its next action.</small></div></div>
    </div>

    {error && <p role="alert" className="danger-text">{error}</p>}
  </>;
}
