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
export function AssistantTeamRow({ assistant, status, selected, backend, onOpen }: { assistant: PersonalAssistantSummary; status: AssistantStatus; selected: boolean; backend?: Backend; onOpen: (ref: AssistantRef) => void }) {
  const look = assistantAppearance(assistant.ref, assistant.look);
  const api = useMemo(() => backend ? createAssistantAvatarApi(backend) : undefined, [backend]);
  return <button type="button" className="assistant-team-row" aria-current={selected ? "page" : undefined} onClick={() => onOpen(assistant.ref)}>
    <Avatar seed={look.seed} color={look.color} size="sm" image={look.kind === "image" ? look.image : undefined} assistant={assistant.ref} avatarApi={api} />
    <span>{assistant.name}{status.state !== "ready" && <span className="assistant-team-subtitle" data-state={status.state}>{status.label}</span>}</span>
  </button>;
}
