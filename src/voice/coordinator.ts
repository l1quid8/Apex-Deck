import { createVoiceController } from "./controller.ts";
import { openVoiceAudio } from "./audio.ts";
import { connectLocalVoice } from "./localClient.ts";
import { preferenceFor, readVoiceSettings } from "./settings.ts";
import type {
  CallScope,
  ThreadVoiceBridge,
  VoiceCandidate,
  VoiceSettings,
} from "./types.ts";
export interface VoiceRegistration {
  candidates: VoiceCandidate[];
  bridge(id: string): ThreadVoiceBridge;
  settings: VoiceSettings;
  save(settings: VoiceSettings): void;
  focus(): void;
}
const registry = new Map<string, VoiceRegistration>();
export const scopeKey = (scope: Pick<CallScope, "hostId" | "roomId">) =>
  JSON.stringify([scope.hostId, scope.roomId]);
const lookup = (scope: CallScope) => {
  const entry = registry.get(scopeKey(scope));
  if (!entry) throw Error("The call thread is no longer open");
  return entry;
};
const runtime = () => {
  const r = window.apexDeck?.voice;
  if (!r) throw Error("Open the desktop app to use local calls");
  return r;
};
export const voiceController = createVoiceController({
  runtime: {
    status: () => runtime().status(),
    start: () => runtime().start(),
    stop: () => runtime().stop(),
  },
  openAudio: openVoiceAudio,
  connect: connectLocalVoice,
  candidates: () => [...registry.values()].flatMap((r) => r.candidates),
  bridge: (scope) => lookup(scope).bridge(scope.participantId),
  voice: (scope) => {
    const e = lookup(scope),
      c = e.candidates.find((c) => c.participantId === scope.participantId);
    return preferenceFor(
      e.settings,
      scope.hostId,
      c?.profileId ?? scope.participantId,
      scope.roomId,
      scope.participantId,
    ).voice;
  },
  silence: () => {
    const scope = voiceController.getState().scope;
    return scope ? lookup(scope).settings.silenceMs : 700;
  },
  focus: (scope) => lookup(scope).focus(),
});
export function registerVoiceThread(key: string, entry: VoiceRegistration) {
  registry.set(key, entry);
}
export function unregisterVoiceThread(key: string) {
  registry.delete(key);
  const scope = voiceController.getState().scope;
  if (scope && scopeKey(scope) === key) void voiceController.end();
}
export function voiceRegistration(scope: CallScope) {
  return lookup(scope);
}
export const defaultVoiceSettings = () => readVoiceSettings(undefined);
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => void voiceController.end());
  window.apexDeck?.voice?.onSuspend(() => void voiceController.end());
}
