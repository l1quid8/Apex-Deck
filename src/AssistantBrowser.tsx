import { PersonalBrowser, type BrowserPresentation } from './PersonalBrowser.tsx';
import type { PersonalLane } from './personalAssistant.ts';

export type AssistantBrowserPresentation = BrowserPresentation | 'closed';
export type AssistantBrowserProps = {
  lane: PersonalLane;
  presentation: AssistantBrowserPresentation;
  onExpand: () => void;
  onReturnToChat: () => void;
  onClose: () => void;
};

/** Keep this mounted beside Chat. Only its placement changes; no browser is created here. */
export function AssistantBrowser({ lane, presentation, onExpand, onReturnToChat, onClose }: AssistantBrowserProps) {
  const owner = JSON.stringify([lane.ref?.hostId ?? lane.assistant?.hostId ?? lane.hostName, lane.ref?.assistantId ?? lane.assistant?.id ?? lane.draftKey]);
  return (
    <div className={`assistant-browser assistant-browser-${presentation}`} hidden={presentation === 'closed'}>
      <PersonalBrowser key={owner} lane={lane} active={presentation !== 'closed'} presentation={presentation === 'expanded' ? 'expanded' : 'popup'} onExpand={onExpand} onReturnToChat={onReturnToChat} onClose={onClose} />
    </div>
  );
}
