import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Avatar } from '../Avatar';
import { assistantAppearance } from '../assistantIdentity';
import { elapsed } from '../composerStatus';
import type { PersonalLane, PersonalAssistantRecord } from '../personalAssistant';
import { PhoneWorkingTurn } from './PhoneWorkingTurn';

export function AssistantWorkingTurn({ lane, event, queued, busy, onStop }: {
  lane: PersonalLane; event: NonNullable<PersonalAssistantRecord['events']>[number];
  queued: number; busy: boolean; onStop?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const progressId = useId();
  useEffect(() => {
    if (lane.offline || event.receivedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lane.offline, event.receivedAt]);
  const ref = lane.ref ?? { hostId: lane.assistant!.hostId, assistantId: lane.assistant!.id };
  const look = assistantAppearance(ref, lane.assistant?.look);
  const active = event.state === 'processing' && !lane.offline;
  const doing = lane.offline ? 'Waiting for connection' : active ? `${lane.name} is working…` : `${lane.name} is waiting…`;
  return <PhoneWorkingTurn name={lane.name} doing={doing} open={open} progressId={progressId}
    onToggle={() => setOpen(!open)} asking={!active} onStop={onStop} stopDisabled={busy || lane.offline}
    time={!lane.offline && event.receivedAt !== undefined ? elapsed(Math.max(0, now - event.receivedAt)) : undefined}
    header={<div className="ph-by" style={{ '--agent-color': look.color } as CSSProperties}><Avatar seed={look.seed} color={look.color} size="sm" working={active} /><span>{lane.name}</span></div>}>
    {queued > 0 && <p className="ph-progress-none">{queued} queued</p>}
    {open && <div id={progressId} className="ph-progress"><p className="ph-progress-none">{lane.offline ? `Reconnect to ${lane.hostName} to see ${lane.name}’s reply.` : active ? `${lane.name} is preparing a reply.` : 'Waiting for this message to be processed.'}</p></div>}
  </PhoneWorkingTurn>;
}
