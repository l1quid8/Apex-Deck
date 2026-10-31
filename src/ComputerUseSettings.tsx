import { useCallback, useEffect, useState } from 'react';
import type { Backend } from './backend';

type ComputerStatus = {
  available: boolean;
  enabled: boolean;
  accessibilityTrusted?: boolean;
  listenEventAccess?: boolean;
  screenCaptureAccess?: boolean;
  stopped?: boolean;
  reason?: string;
};

export function ComputerUseSettings({ backend }: { backend: Backend }) {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { setStatus(await backend.call<ComputerStatus>('computer_status')); setError(''); }
    catch { setError('Unified Computer Use is unavailable on this host. Update the desktop app and try again.'); }
  }, [backend]);
  useEffect(() => {
    if (backend.demo) return;
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [backend.demo, refresh]);
  const act = async (command: string, args?: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { await backend.call(command, args); await refresh(); }
    catch { setError('The request could not finish. Open Unified Computer Use from the menu bar and check its status.'); }
    finally { setBusy(false); }
  };
  const permission = (value: boolean | undefined) => value === true ? 'Allowed' : value === false ? 'Not allowed' : 'Open the helper to check';
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
      <div className="settings-row">
        <div className="settings-label"><strong>Stop Unified Computer Use</strong><small>Cancels active input and revokes the current turns. The helper also has an independent Stop control in the menu bar.</small></div>
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
