import { useMemo } from "react";
import { Avatar } from "./Avatar";
import { createAssistantAvatarApi } from "./assistantAvatar";
import { assistantAppearance } from "./assistantIdentity";
import type { AssistantRef } from "./assistantIdentity";
import type { AssistantStatus } from "./assistantStatus";
import type { Backend } from "./backend";
import type { PersonalAssistantSummary } from "./usePersonalAssistants";

/** One teammate in the rail. A Ready teammate is quiet: only the states
 *  that ask for attention get words under the name. */
export function AssistantTeamRow({ assistant, status, selected, backend, onOpen, floated = false, onPopOut }: { assistant: PersonalAssistantSummary; status: AssistantStatus; selected: boolean; backend?: Backend; onOpen: (ref: AssistantRef) => void; floated?: boolean; onPopOut?: (ref: AssistantRef) => void }) {
  const look = assistantAppearance(assistant.ref, assistant.look);
  const api = useMemo(() => backend ? createAssistantAvatarApi(backend) : undefined, [backend]);
  return <div className={`assistant-team-group${selected ? " selected" : ""}`} data-status={status.state}><button type="button" className="assistant-team-row" aria-current={selected ? "page" : undefined} aria-label={status.state==='ready'?assistant.name:`${assistant.name}, ${status.label}`} onClick={() => onOpen(assistant.ref)}>
    <Avatar seed={look.seed} color={look.color} size="sm" image={look.kind === "image" ? look.image : undefined} assistant={assistant.ref} avatarApi={api} />
    <span>{assistant.name}{status.state !== "ready" && <span className="assistant-team-subtitle" data-state={status.state}>{status.label}</span>}</span>
  </button>{!floated && onPopOut && <button type="button" className="assistant-team-popout" aria-label={`Pop out ${assistant.name}`} title={`Show floating ${assistant.name}`} onClick={() => onPopOut(assistant.ref)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M14 3h7v7M21 3l-11 11"/></svg></button>}</div>;
}
