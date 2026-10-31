import type { Backend } from "../backend.ts";
import type { ParticipantQueues } from "../turnQueue.ts";
import {
  createVoiceController,
  type VoiceDependencies,
  type VoiceController,
} from "../voice/controller.ts";
import { joinVoiceEngines } from "../voice/engineController.ts";
import { createRealtimeVoiceController } from "../voice/realtimeController.ts";
import { connectServerVoice } from "../voice/serverClient.ts";
import { openVoiceAudio } from "../voice/audio.ts";
import { preferenceFor, readVoiceSettings, voiceFor } from "../voice/settings.ts";
import { createThreadVoiceBridge } from "../voice/threadBridge.ts";
import { machineVoice, type PhoneTouched } from "./machineVoice.ts";
import type { CallLook } from "../voice/callView.ts";
import type {
  CallEngine,
  CallScope,
  ServerVoiceLink,
  ServerVoiceRuntime,
  VoiceCandidate,
  VoiceSettings,
} from "../voice/types.ts";
export const PHONE_VOICE_KEY = "apex-deck.phone.voice.v1",
  PHONE_VOICE_USED_KEY = "apex-deck.phone.voice.used.v1",
  PHONE_VOICE_TOUCHED_KEY = "apex-deck.phone.voice.touched.v1";
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
  ): readonly { id: string; display_name: string; media?: unknown; voice?: string | null }[];
  roomTitle?(hostId: string, roomId: string): string | undefined;
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
  /** The phone's own call settings. */
  settings(): VoiceSettings;
  /** What a call in this machine's threads uses: the phone's choices over the machine's saved ones. */
  settingsFor(hostId: string): VoiceSettings;
  /** Save from the settings sheet. Fields that differ from `settingsFor(hostId)` become the phone's own. */
  save(settings: VoiceSettings, hostId?: string): void;
  look(hostId: string): CallLook;
  /** Which engine the running call uses; "local" when no call is on. */
  engine(): CallEngine;
  /** Read the machine's saved call settings again, so a call uses its current engine. */
  refreshSettings(hostId: string): Promise<void>;
  /** Call before a wait that leads to `start`; the check turns false once the call is ended or another starts. */
  startWanted(): () => boolean;
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
  const rawTouched = read(PHONE_VOICE_TOUCHED_KEY);
  const touched: PhoneTouched = {
    silence: rawTouched?.silence === true,
    look: rawTouched?.look === true,
    realtimeVoice: rawTouched?.realtimeVoice === true,
    realtimeModel: rawTouched?.realtimeModel === true,
  };
  const machines = new Map<string, VoiceSettings>(),
    machineLoaded = new Map<string, number>(),
    machineLoading = new Map<string, Promise<void>>();
  const settingsFor = (hostId: string) =>
    machineVoice(settings, machines.get(hostId) ?? null, touched, hostId);
  // The machine's saved call settings (pause, look, voices, engine). Reading them needs Full access; without it the phone keeps its own.
  const loadMachine = (id: string, maxAgeMs: number): Promise<void> => {
    const h = deps.host(id),
      now = (deps.now ?? Date.now)(),
      last = machineLoaded.get(id);
    if (!h?.backend.settingsLoad) return Promise.resolve();
    if (last !== undefined && now - last < maxAgeMs) return machineLoading.get(id) ?? Promise.resolve();
    machineLoaded.set(id, now);
    const loading: Promise<void> = h.backend
      .settingsLoad()
      .then((raw) => {
        const voice = raw && typeof raw === "object" ? (raw as { voice?: unknown }).voice : undefined;
        if (!voice) return;
        machines.set(id, readVoiceSettings(voice));
        changed();
      })
      .catch(() => {})
      .finally(() => {
        if (machineLoading.get(id) === loading) machineLoading.delete(id);
      });
    machineLoading.set(id, loading);
    return loading;
  };
  // Just before a call: the engine may have changed on the Mac, but a slow link mustn't hold the call up.
  const refreshSettings = (id: string) =>
    Promise.race([loadMachine(id, 1000), new Promise<void>((done) => setTimeout(done, 2000))]);
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
        roomTitle: deps.roomTitle?.(hostId, roomId),
        participantId: p.id,
        profileId: p.id,
        name: p.display_name,
        agentVoice: p.voice,
        aliases: preferenceFor(settingsFor(hostId), hostId, p.id, roomId, p.id)
          .aliases,
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
  const focus = (s: CallScope) => {
    if (!deps.onScreen(s.hostId, s.roomId)) {
      attention = true;
      changed();
    }
  };
  const local: VoiceController<ServerVoiceRuntime> =
    createVoiceController<ServerVoiceRuntime>({
      runtime: {
        status: () => {
          const s = local.getState().scope;
          return host(s!.hostId).voice.status();
        },
        start: async () => {
          const s = local.getState().scope!;
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
      candidates: () => {
        const s = local.getState().scope;
        return s ? candidates(s.hostId, s.roomId) : [];
      },
      bridge,
      voice: (s) =>
        voiceFor(
          settingsFor(s.hostId),
          s.hostId,
          s.participantId,
          s.roomId,
          s.participantId,
          deps.participants(s.hostId, s.roomId).find((p) => p.id === s.participantId)?.voice,
        ),
      silence: () => {
        const s = local.getState().scope;
        return (s ? settingsFor(s.hostId) : settings).silenceMs;
      },
      focus,
    });
  const realtime = createRealtimeVoiceController({
    candidates: () => {
      const s = realtime.getState().scope;
      return s ? candidates(s.hostId, s.roomId) : [];
    },
    bridge,
    voiceSettings: () => {
      const s = realtime.getState().scope;
      return s ? settingsFor(s.hostId) : settings;
    },
    // The machine holds the OpenAI key; the phone only gets the short-lived pass.
    mintSession: async (args) => {
      const s = realtime.getState().scope;
      if (!s) throw Error("The call ended");
      const h = host(s.hostId);
      await h.whenConnected(10000);
      try {
        return await h.backend.call("voice_realtime_session", args);
      } catch (error) {
        if (/unknown variant/.test(String(error))) throw Error(`Update ${h.name} to use GPT-Live calls.`);
        throw error;
      }
    },
    focus,
  });
  const engines = joinVoiceEngines(
    local,
    realtime,
    (s) => settingsFor(s.hostId).engine,
    (s) => refreshSettings(s.hostId),
  );
  const controller: VoiceController<ServerVoiceRuntime> = engines.controller;
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
    settingsFor,
    look: (hostId) => settingsFor(hostId).look,
    engine: engines.engine,
    startWanted: engines.startWanted,
    refreshSettings,
    save: (value, hostId) => {
      const before = hostId ? settingsFor(hostId) : settings;
      // The engine is only ever the machine's, so the phone's copy stays Local.
      settings = { ...readVoiceSettings(value), engine: "local" };
      if (settings.silenceMs !== before.silenceMs) touched.silence = true;
      if (settings.look !== before.look) touched.look = true;
      if (settings.realtimeVoice !== before.realtimeVoice) touched.realtimeVoice = true;
      if (settings.realtimeModel !== before.realtimeModel) touched.realtimeModel = true;
      try {
        deps.storage.setItem(PHONE_VOICE_KEY, JSON.stringify(settings));
        deps.storage.setItem(PHONE_VOICE_TOUCHED_KEY, JSON.stringify(touched));
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
      void loadMachine(id, 60000);
      if (settingsFor(id).engine !== "realtime" && used.has(id) && (!warm.has(id) || now - warm.get(id)! >= 60000)) {
        warm.set(id, now);
        void deps
          .host(id)
          ?.voice.warm(room)
          .catch(() => {});
      }
    },
    // Always ends: a call still waiting on the machine has no status yet.
    leftScreen: () => void controller.end("app left the screen"),
  };
}
