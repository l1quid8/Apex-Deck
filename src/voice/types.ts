import type { Unlisten } from "../backend";
export type CallScope = {
  hostId: string;
  roomId: string;
  participantId: string;
};
export type VoiceCandidate = CallScope & {
  name: string;
  profileId: string;
  aliases: string[];
};
export type VoiceTurn = {
  callId: string;
  generation: number;
  utteranceId: string;
  requestId: string;
  scope: CallScope;
  text: string;
};
export type VoicePreferences = { voice: string; aliases: string[] };
export type VoiceSettings = {
  enabled: boolean;
  silenceMs: number;
  preferences: Record<string, VoicePreferences>;
};
export type VoiceState = {
  status:
    | "off"
    | "setup"
    | "warming"
    | "listening"
    | "hearing"
    | "waiting"
    | "speaking"
    | "needs-attention"
    | "error";
  scope?: CallScope;
  muted: boolean;
  semantic?: boolean;
  error?: string;
  voices: string[];
  candidates?: VoiceCandidate[];
};
export type BridgeEvent = {
  requestId: string;
  scope: CallScope;
  type:
    | "started"
    | "text"
    | "approval"
    | "question"
    | "done"
    | "failed"
    | "canceled";
  text?: string;
};
export interface ThreadVoiceBridge {
  submit(turn: VoiceTurn): Promise<{ requestId: string }>;
  cancel(requestId: string): Promise<void>;
  subscribe(listener: (event: BridgeEvent) => void): Unlisten;
}
export type VoiceRuntime = { port: number; token: string; protocolVersion: 1 };
export type HelperEvent = {
  type: string;
  callId: string;
  generation: number;
  requestId?: string;
  segmentId?: number;
  text?: string;
  voices?: string[];
  sampleRate?: number;
  state?: string;
  message?: string;
  semantic?: boolean;
};
