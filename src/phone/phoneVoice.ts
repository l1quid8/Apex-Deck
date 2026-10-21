import type { Backend } from "../backend.ts";
import type { ParticipantQueues } from "../turnQueue.ts";
import {
  createVoiceController,
  type VoiceDependencies,
  type VoiceController,
} from "../voice/controller.ts";
import { connectServerVoice } from "../voice/serverClient.ts";
import { openVoiceAudio } from "../voice/audio.ts";
import { preferenceFor, readVoiceSettings } from "../voice/settings.ts";
import { createThreadVoiceBridge } from "../voice/threadBridge.ts";
import type {
  CallScope,
  ServerVoiceLink,
  ServerVoiceRuntime,
  VoiceCandidate,
  VoiceSettings,
} from "../voice/types.ts";
export const PHONE_VOICE_KEY = "apex-deck.phone.voice.v1",
  PHONE_VOICE_USED_KEY = "apex-deck.phone.voice.used.v1";
export interface PhoneVoiceHost {
  name: string;
  backend: Backend;
  voice: ServerVoiceLink;
  canCall(): boolean;
  whenConnected(timeoutMs: number): Promise<void>;
}
export interface PhoneVoiceDeps {
  host(hostId: string): PhoneVoiceHost | null;
  queue(hostId: string, roomId: string): ParticipantQueues;
  participants(
    hostId: string,
    roomId: string,
  ): readonly { id: string; display_name: string; media?: unknown }[];
  onScreen(hostId: string, roomId: string): boolean;
  storage: Pick<Storage, "getItem" | "setItem">;
  keepAwake(on: boolean): void;
  openAudio?: VoiceDependencies["openAudio"];
  connect?: typeof connectServerVoice;
  now?: () => number;
}
export interface PhoneVoice {
  controller: VoiceController<ServerVoiceRuntime>;
  canCall(hostId: string): boolean;
  candidates(hostId: string, roomId: string): VoiceCandidate[];
  settings(): VoiceSettings;
  save(settings: VoiceSettings): void;
  view(): { weak: boolean; attention: boolean };
  subscribe(fn: () => void): () => void;
  failed(
    hostId: string,
    roomId: string,
    participantId: string,
    requestId: string,
    error: unknown,
  ): void;
  threadOpened(hostId: string, roomId: string): void;
  leftScreen(): void;
}
export function createPhoneVoice(deps: PhoneVoiceDeps): PhoneVoice {
  const read = (key: string) => {
    try {
      return JSON.parse(deps.storage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  };
  let settings = readVoiceSettings(read(PHONE_VOICE_KEY));
  const rawUsed = read(PHONE_VOICE_USED_KEY);
  const used = new Set<string>(
    Array.isArray(rawUsed)
      ? rawUsed.filter((x): x is string => typeof x === "string")
      : [],
  );
  const warm = new Map<string, number>(),
    bridges = new Map<string, ReturnType<typeof createThreadVoiceBridge>>();
  const listeners = new Set<() => void>();
  let weak = false,
    attention = false,
    awake = false;
  const active = new Map<ServerVoiceRuntime, ServerVoiceLink>();
  const changed = () => listeners.forEach((fn) => fn());
  const host = (id: string) => {
    const h = deps.host(id);
    if (!h) throw Error("This machine is no longer paired");
    return h;
  };
  const candidates = (hostId: string, roomId: string): VoiceCandidate[] =>
    deps
      .participants(hostId, roomId)
      .filter((p) => !p.media)
      .map((p) => ({
        hostId,
        roomId,
        participantId: p.id,
        profileId: p.id,
        name: p.display_name,
        aliases: preferenceFor(settings, hostId, p.id, roomId, p.id).aliases,
      }));
  const bridge = (scope: CallScope) => {
    const key = JSON.stringify([scope.hostId, scope.roomId, scope.participantId]);
    let made = bridges.get(key);
    if (made) return made;
    made = createThreadVoiceBridge({
      backend: host(scope.hostId).backend,
      scope,
      enqueue: (turn, canceled) =>
        deps
          .queue(scope.hostId, scope.roomId)
          .sendTo(turn.text, [scope.participantId], {
            requestId: turn.requestId,
            canceled,
          }),
      remove: (requestId) => {
        const q = deps.queue(scope.hostId, scope.roomId),
          item = q.items.find((i) => i.voice?.requestId === requestId);
        if (!item) return false;
        q.remove(item.id);
        return true;
      },
    });
    bridges.set(key, made);
    return made;
  };
  const controller: VoiceController<ServerVoiceRuntime> =
    createVoiceController<ServerVoiceRuntime>({
      runtime: {
        status: () => {
          const s = controller.getState().scope;
          return host(s!.hostId).voice.status();
        },
        start: async () => {
          const s = controller.getState().scope!;
          const h = host(s.hostId);
          await h.whenConnected(10000);
          const runtime = await h.voice.open(s.roomId);
          active.set(runtime, h.voice);
          return runtime;
        },
        stop: async (runtime) => {
          if (!runtime) return;
          const link = active.get(runtime);
          active.delete(runtime);
          if (link) await link.close(runtime.channel, "call ended");
        },
      },
      connect: async (runtime, event, audio, error) => {
        const link = active.get(runtime);
        if (!link) throw Error("Voice disconnected");
        const connected = await (deps.connect ?? connectServerVoice)(
          link,
          runtime,
          event,
          audio,
          error,
          (value) => {
            weak = value;
            changed();
          },
        );
        return {
          ...connected,
          close(reason) {
            active.delete(runtime);
            connected.close(reason);
          },
        };
      },
      openAudio: deps.openAudio ?? openVoiceAudio,
      keepWorkOnError: true,
      candidates: () => {
        const s = controller.getState().scope;
        return s ? candidates(s.hostId, s.roomId) : [];
      },
      bridge,
      voice: (s) =>
        preferenceFor(
          settings,
          s.hostId,
          s.participantId,
          s.roomId,
          s.participantId,
        ).voice,
      silence: () => settings.silenceMs,
      focus: (s) => {
        if (!deps.onScreen(s.hostId, s.roomId)) {
          attention = true;
          changed();
        }
      },
    });
  controller.subscribe(() => {
    const s = controller.getState(),
      on = !["off", "error", "setup"].includes(s.status);
    if (on !== awake) {
      awake = on;
      deps.keepAwake(on);
    }
    if (s.status === "listening" && s.scope && !used.has(s.scope.hostId)) {
      used.add(s.scope.hostId);
      try {
        deps.storage.setItem(PHONE_VOICE_USED_KEY, JSON.stringify([...used]));
      } catch {}
    }
    if (!on) {
      weak = false;
      attention = false;
    }
    changed();
  });
  return {
    controller,
    candidates,
    canCall: (id) => deps.host(id)?.canCall() ?? false,
    settings: () => settings,
    save: (value) => {
      settings = readVoiceSettings(value);
      try {
        deps.storage.setItem(PHONE_VOICE_KEY, JSON.stringify(settings));
      } catch {}
      changed();
    },
    view: () => ({ weak, attention }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    failed: (hostId, roomId, participantId, id, error) =>
      bridge({ hostId, roomId, participantId }).fail(id, error),
    threadOpened: (id, room) => {
      const s = controller.getState().scope;
      if (s?.hostId === id && s.roomId === room) {
        attention = false;
        changed();
      }
      const now = (deps.now ?? Date.now)();
      if (used.has(id) && (!warm.has(id) || now - warm.get(id)! >= 60000)) {
        warm.set(id, now);
        void deps
          .host(id)
          ?.voice.warm(room)
          .catch(() => {});
      }
    },
    leftScreen: () => {
      if (controller.getState().status !== "off")
        void controller.end("app left the screen", { keepWork: true });
    },
  };
}
