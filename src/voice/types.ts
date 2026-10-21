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
  /** How a running call shows on screen (callView.ts). */
  look: import("./callView.ts").CallLook;
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
  /** Date.now() when this call started, for its timer. */
  startedAt?: number;
  /** The helper dropped and the call is opening a fresh connection. */
  reconnecting?: boolean;
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
export type VoiceFrame = { channel: number } & ({ ctl: Record<string, unknown> } | { bin: string } | { rx: number } | { closed: string });
export type ServerVoiceRuntime = { channel: number; protocolVersion: 1 };
export type ServerVoiceStatus = { supported: boolean; reason?: string; installed: boolean; installing?: { stage: string; downloaded: number; total: number }; failed?: string; running: boolean; busy: boolean; downloadBytes: number; requiredDiskBytes: number };
export interface ServerVoiceLink {
  status(): Promise<ServerVoiceStatus>; install(): Promise<void>; cancelInstall(): Promise<void>;
  warm(room: string): Promise<void>; open(room: string): Promise<ServerVoiceRuntime>; close(channel: number, reason: string): Promise<void>;
  attach(channel: number, cb: (frame: VoiceFrame) => void): () => void;
  send(frame: VoiceFrame): boolean;
  onLost(cb: (reason: string) => void): () => void;
}
