import type { Backend } from './backend';
import type { ParticipantConfig, RoomState } from './types';

export interface ChatThreadRoute {
  room: string;
  online(): boolean;
  blocked(): string | null;
  cached(): RoomState | null;
  historyBlocked?(): string | null;
  remember(state: RoomState): void;
  send(text: string): void;
  profile(id: string): string | undefined;
}

/** Adapt only the chat-specific operations; the shared thread retains its existing reads/actions. */
export function chatThreadBackend(backend: Backend, route: ChatThreadRoute): Backend {
  const writable = () => {
    const reason = route.blocked();
    if (reason) throw new Error(reason);
    if (!route.online()) throw new Error('The machine is reconnecting. Try again when it is connected.');
  };
  const state = async (): Promise<RoomState> => {
    if (!route.online() && backend.host?.connection.get().status.kind !== "resync") {
      const cached = route.cached();
      if (cached) return cached;
      throw new Error('Open this chat once while its machine is connected to see it.');
    }
    const saved = backend.roomState ? await backend.roomState(route.room) : await backend.call<RoomState>('room_state', {id:route.room});
    route.remember(saved);
    return saved;
  };
  const post = async (_room: string, text: string) => {
    const reason = route.blocked();
    if (reason) throw new Error(reason);
    route.send(text);
  };
  const overrides: Partial<Backend> = {
    roomState: state,
    // Never create a Work room when a chat read fails or a helper asks for totals.
    roomCreate: async () => (await state()).snapshot,
    roomClose: async () => {},
    roomUpdateParticipant: async (_room, config, base) => {
      writable();
      const current = (await state()).snapshot.participants.find(p => p.id === config.id);
      if (!current) throw new Error('This bot is no longer in the chat.');
      writable();
      const fields = (p: ParticipantConfig) => p.backend.kind === 'agent' || p.backend.kind === 'open_ai_compatible' ? p.backend : null;
      // Compare with the edit base, so another device's unrelated edits survive.
      const previous = base ?? current;
      const next = fields(config), before = fields(previous);
      const patch: Record<string, unknown> = {};
      if (config.display_name !== previous.display_name) patch.display_name = config.display_name;
      if (next?.model !== before?.model) patch.model = next?.model ?? null;
      if (config.effort !== previous.effort) patch.effort = config.effort ?? null;
      if (config.speed !== previous.speed) patch.speed = config.speed ?? null;
      if (!Object.keys(patch).length) return current;
      return backend.call<ParticipantConfig>('chat_update_participant', {id:route.room, participant:config.id, patch});
    },
    roomAddParticipant: async (_room, config) => {
      writable();
      const profile = route.profile(config.id);
      if (!profile) throw new Error('Choose a saved bot from this machine.');
      await backend.call('chat_add_participant', {id:route.room, participant:{profile, id:config.id}});
    },
    roomRemoveParticipant: async (_room, participant) => {
      writable();
      await backend.call('chat_remove_participant', {id:route.room, participant});
    },
    roomPost: post,
    roomPostTo: post,
    roomRevertPlan: async () => ({ available:false, note:'Only chat history goes back; this chat has no files.', files:[], skipped:[], effects:[] }),
  };
  const history = new Set(['roomClear','roomRevert','roomCompact']);
  const mutations = new Set(['answerSave','roomClear','roomCompact','roomSetOptions','roomPin','roomUnpin','roomRevert','roomTurn','roomStop','roomSetEditor']);
  const guarded = new Map<PropertyKey, unknown>();
  return new Proxy(backend, {
    get(target, key) {
      if (key in overrides) return overrides[key as keyof Backend];
      const value = Reflect.get(target, key);
      if (typeof key === 'string' && mutations.has(key) && typeof value === 'function') {
        if (!guarded.has(key)) guarded.set(key, async (...args: unknown[]) => { writable(); const reason = history.has(key) ? route.historyBlocked?.() : null; if (reason) throw new Error(reason); return value(...args); });
        return guarded.get(key);
      }
      return value;
    },
  });
}
