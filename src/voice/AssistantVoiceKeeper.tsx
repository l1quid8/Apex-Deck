import type { Backend } from '../backend';
import type { PersonalLane } from '../personalAssistant';
import type { VoiceSettings } from './types';
import { useAssistantVoice } from './useAssistantVoice';

/** Keeps an assistant's call registered while only its floating window shows it. */
export function AssistantVoiceKeeper(props: { lane: PersonalLane; backend?: Backend; settings?: VoiceSettings; onSettings?: (settings: VoiceSettings) => void }) {
  useAssistantVoice(props);
  return null;
}
