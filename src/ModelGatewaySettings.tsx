import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from './backend';
import { ConfirmDialog, type Question } from './ConfirmDialog';
import { gatewayApi, gatewayOwner, issueGatewaySpec, type GatewayIssued, type GatewayKey, type GatewayProvider, type GatewayStatus } from './modelGateway';
import './model-gateway-settings.css';

export function ModelGatewaySettings({ backend }: { backend: Backend }) {
  if (!gatewayOwner(backend)) return <p role="status">Only the local host owner can manage the model gateway.</p>;
  return <OwnerGateway key={backend.host?.id} backend={backend} />;
}

function OwnerGateway({ backend }: { backend: Backend }) {
  const api = useMemo(() => gatewayApi(backend), [backend]);
  const alive = useRef(true);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [keys, setKeys] = useState<GatewayKey[] | null>(null);
  const [providers, setProviders] = useState<GatewayProvider[] | null>(null);
  const [tab, setTab] = useState<'keys' | 'providers'>('keys');
  const [bind, setBind] = useState('127.0.0.1');
  const [port, setPort] = useState('8787');
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState('all');
  const [daily, setDaily] = useState('100');
  const [usd, setUsd] = useState('25');
  const [issued, setIssued] = useState<GatewayIssued | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [note, setNote] = useState('');
  const [question, setQuestion] = useState<Question | null>(null);
  const fail = useCallback((error: unknown) => { if (alive.current) setProblem(error instanceof Error ? error.message : String(error)); }, []);
  const refresh = useCallback(async () => {
    const [next, registry] = await Promise.all([api.status(), api.list()]);
    if (alive.current) { setStatus(next); setKeys(registry.keys); }
    return next;
  }, [api]);
  useEffect(() => {
    alive.current = true;
    let active = true;
    refresh().then(next => { if (active) { setBind(next.bind); setPort(String(next.port)); } }, fail);
    api.providers().then(result => { if (active) setProviders(result.providers); }, fail);
    return () => { active = false; alive.current = false; };
  }, [api, refresh, fail]);

  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setProblem(''); setNote('');
    try { await action(); } catch (e) { fail(e); }
    finally { if (alive.current) setBusy(false); }
  };
  const configure = (enabled: boolean, useDraft: boolean) => perform(async () => {
    const n = useDraft ? Number(port) : status!.port;
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Enter a port from 1 to 65535.');
    const next = await api.configure({ enabled, bind: useDraft ? bind.trim() : status!.bind, port: n });
    if (alive.current) { setStatus(next); setBind(next.bind); setPort(String(next.port)); setNote(next.enabled ? 'Gateway enabled. Settings saved.' : 'Gateway disabled. Keys are preserved.'); }
  });
  const create = () => perform(async () => {
    const spec = issueGatewaySpec(label, scope, daily, usd);
    const result = await api.issue(spec);
    if (!alive.current) return;
    setIssued(result); setEditing(false); setLabel(''); setNote('Key created. Copy the secret before dismissing it.');
    await refresh();
  });
  const revoke = (key: GatewayKey) => setQuestion({ title: `Revoke ${key.label}?`, body: 'This key will stop working immediately, including active requests. Create a new key to restore access.', action: 'Revoke key', onConfirm: () => { void perform(async () => {
    await api.revoke(key.id);
    if (alive.current) { setIssued(current => current?.key.id === key.id ? null : current); setNote(`${key.label} revoked.`); }
    await refresh();
  }); } });
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); if (alive.current) setNote('Copied to clipboard.'); }
    catch { if (alive.current) setProblem('Could not copy. Select and copy the text manually.'); }
  };
  const changed = status && (bind.trim() !== status.bind || port !== String(status.port));
  return <div className="model-gateway">
    <div className="gateway-intro"><div><h3>One endpoint. Your models.</h3><p>Connect your other devices with keys you control.</p></div><span className="gateway-badge">Host owner</span></div>
    <section className="settings-card gateway-endpoint" aria-label="Gateway endpoint">
      <div className="gateway-between"><div><span className="gateway-state">{status ? status.enabled ? '● Enabled' : '○ Disabled' : 'Loading gateway…'}</span><h3>Gateway endpoint</h3></div><button disabled={!status || busy} onClick={() => void configure(!status!.enabled, !status!.enabled)}>{status?.enabled ? 'Disable gateway' : 'Enable gateway'}</button></div>
      <div className="gateway-url"><code>{status?.baseUrl ?? 'Enable the gateway to get an endpoint URL'}</code>{status?.baseUrl && <button className="ghost" onClick={() => void copy(status.baseUrl!)}>Copy URL</button>}</div>
      <div className="gateway-fields"><label>Listen address<input value={bind} disabled={!status || busy || status.enabled} onChange={e => setBind(e.target.value)} placeholder="127.0.0.1" spellCheck={false} /></label><label>Port<input type="number" min="1" max="65535" step="1" value={port} disabled={!status || busy || status.enabled} onChange={e => setPort(e.target.value)} /></label><button disabled={!status || !changed || busy || status.enabled} onClick={() => void configure(status!.enabled, true)}>Save endpoint</button></div>
      {status?.error && <p role="alert" className="error">{status.error} Update the address or port and enable the gateway again.</p>}
      <p>Disable the gateway before changing its address or port. 127.0.0.1 is accessible on this host only. For other devices, use a private network address and an encrypted tunnel or HTTPS proxy. The listener serves HTTP.</p>
      <div className="gateway-facts"><span>OpenAI-compatible</span><span>Bearer authentication</span><span>Host must stay online</span></div>
    </section>
    <div className="gateway-tabs" role="group" aria-label="Gateway views"><button aria-pressed={tab === 'keys'} onClick={() => setTab('keys')}>API keys</button><button aria-pressed={tab === 'providers'} onClick={() => setTab('providers')}>Providers</button><button className="ghost" disabled={busy} onClick={() => void perform(async () => { await refresh(); const result = await api.providers(); if (alive.current) setProviders(result.providers); setNote('Gateway refreshed.'); })}>Refresh</button></div>
    {problem && <p role="alert" className="error gateway-message">{problem} If this daemon predates Model gateway, update it and reconnect.</p>}
    <div role="status" className="gateway-message">{busy ? 'Working…' : note}</div>
    {tab === 'keys' ? <section aria-label="Gateway API keys">
      <div className="gateway-between gateway-section-head"><div><h3>Access you’ve issued</h3><p>Only the host owner can create and revoke keys.</p></div><button className="primary" disabled={!status || busy || !!issued} onClick={() => setEditing(true)}>Create key</button></div>
      {issued && <section className="settings-card gateway-secret" aria-label="New API key"><h3>Copy this key now</h3><p>This secret is shown once. It will disappear when you dismiss this panel or leave Settings.</p><label>API key<input readOnly value={issued.token} autoComplete="off" spellCheck={false} onFocus={e => e.currentTarget.select()} /></label><div className="settings-actions"><button onClick={() => void copy(issued.token)}>Copy key</button><button disabled={!status?.baseUrl} onClick={() => void copy(`Base URL: ${status!.baseUrl}\nAPI key: ${issued.token}`)}>Copy setup</button><button className="ghost" onClick={() => { setIssued(null); setNote('Key saved. Its secret can no longer be shown.'); }}>Done</button></div></section>}
      {editing && <form className="settings-card gateway-editor" onSubmit={e => { e.preventDefault(); void create(); }}><h3>Create a key</h3><div className="gateway-fields"><label>Device or person<input autoFocus value={label} maxLength={60} required disabled={busy} onChange={e => setLabel(e.target.value)} /></label><label>Model access<select value={scope} disabled={busy} onChange={e => setScope(e.target.value)}><option value="all">All available models</option><option value="api">API providers only</option><option value="sub">Subscription CLIs only</option></select></label><label>Daily requests<input type="number" min="1" max="10000" step="1" value={daily} placeholder="Unlimited" disabled={busy} onChange={e => setDaily(e.target.value)} /></label><label>Spend cap (USD / 30-day period)<input type="number" min="0.01" max="1000000" step="0.01" value={usd} placeholder="Unlimited" disabled={busy} onChange={e => setUsd(e.target.value)} /></label></div><p>Blank limits are unlimited. All available models includes future models and compatible custom CLI profiles. Keys remain active until revoked. Private MCP tools are always excluded.</p><div className="settings-actions"><button className="primary" disabled={busy} type="submit">Create key</button><button type="button" className="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div></form>}
      <div className="settings-card gateway-keys">{keys === null ? <p>Loading issued keys…</p> : keys.length === 0 ? <div className="gateway-empty"><h3>No gateway keys yet</h3><p>Create a key for a device or person you want to give access.</p></div> : keys.map(key => <div className="gateway-key" key={key.id}><div><strong>{key.label}</strong><code>{key.prefix}</code><p>{key.scopes.map(scope => ({sub:'Subscription CLIs',api:'API providers',cli:'Custom CLIs'})[scope]).join(', ')} · Until revoked</p><p>{key.turns_today} / {key.max_turns_per_day ?? 'unlimited'} requests today · ${(key.spend_micros_month / 1000000).toFixed(2)} / {key.max_usd_micros_per_month == null ? 'unlimited' : `$${(key.max_usd_micros_per_month / 1000000).toFixed(2)}`} this period</p><p>Last used: {key.last_used_at ? new Date(key.last_used_at * 1000).toLocaleString() : 'Never'}</p></div><button className="ghost" disabled={busy} onClick={() => revoke(key)}>Revoke</button></div>)}</div>
      <p className="gateway-note">Spend is recorded when providers report it. Limits use UTC-aligned 30-day periods; a request can exceed the remaining spend cap. Daily request limits apply across all model families.</p>
    </section> : <section aria-label="Provider readiness"><div className="gateway-section-head"><h3>Provider readiness</h3><p>Installation and configuration checks only. Authentication and real completions are not tested here.</p></div><div className="settings-card gateway-providers">{providers === null ? <p>Loading providers…</p> : providers.map(provider => <div className="gateway-key" key={`${provider.kind}-${provider.id}`}><div><strong>{provider.name}</strong><p>{provider.kind} · {provider.detail}</p></div><span className="gateway-badge">{provider.available ? 'Configured' : 'Unavailable'}</span></div>)}</div></section>}
    <section className="settings-card gateway-privacy"><h3>Private tools stay private</h3><p><code>x_mcp</code> and <code>hl_mcp</code> are excluded from gateway clients, including older keys. Your local tools stay available to you.</p><span className="gateway-note">Always enforced · No per-key override</span></section>
    {question && <ConfirmDialog question={question} onCancel={() => setQuestion(null)} />}
  </div>;
}
