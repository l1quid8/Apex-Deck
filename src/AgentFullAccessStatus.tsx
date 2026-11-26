import { useEffect, useRef, useState } from 'react';
import type { Backend } from './backend';
import type { ParticipantConfig } from './types';
import { confirmAgentFullAccess } from './agentFullAccess';

/** Available even when the agent cannot start a reply. Approval belongs to this host. */
export function AgentFullAccessStatus({ backend, config }: { backend: Backend; config: ParticipantConfig }) {
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const supported = backend.supports?.('agent_full_access_v1') === true;
  useEffect(() => {
    let live = true;
    generation.current++;
    setApproved(false); setError(''); setBusy(false);
    if (supported) {
      void backend.call<{ approved: boolean }>('agent_full_access', { agent: config.id })
        .then(status => { if (live) setApproved(status.approved); })
        .catch(error => { if (live) setError(String(error)); });
    }
    return () => { live = false; generation.current++; };
  }, [backend, config.id, config.access, supported]);
  if (config.access !== 'full' && !approved && !error) return null;
  return <div className="agent-full-access" role="group" aria-label="Agent-wide Full access">
    <p className="muted" role="status">{!supported ? 'Update this machine’s Apex Deck service to confirm agent-wide Full access.' : approved ? 'Full access confirmed on this machine across this agent’s allowed folders and threads. This approval applies while the agent uses Full access.' : 'Confirm Full access once on this machine to allow code written by other agents across this agent’s allowed folders.'}</p>
    {supported && !approved && config.access === 'full' && <button type="button" disabled={busy} onClick={async () => {
      const token = generation.current;
      setBusy(true); setError('');
      try { await confirmAgentFullAccess(backend, config); if (generation.current === token) setApproved(true); }
      catch (error) { if (generation.current === token) setError(String(error)); }
      finally { if (generation.current === token) setBusy(false); }
    }}>{busy ? 'Saving…' : 'Confirm Full access'}</button>}
    {supported && approved && <button type="button" disabled={busy} onClick={async () => {
      if (!window.confirm(`Revoke Full access approval for ${config.display_name} on ${backend.host?.name ?? 'this machine'}? Active Full-access copies of this agent on this machine will be stopped.`)) return;
      const token = generation.current;
      setBusy(true); setError('');
      try {
        const result = await backend.call<{ approved: boolean }>('agent_full_access', { agent: config.id, revoke: true });
        if (result.approved) throw new Error('The machine did not revoke the Full access approval.');
        if (generation.current === token) setApproved(false);
      } catch (error) { if (generation.current === token) setError(String(error)); }
      finally { if (generation.current === token) setBusy(false); }
    }}>{busy ? 'Saving…' : 'Revoke Full access approval'}</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
