// Interactive answers: the settings people choose on cards, kept per thread
// by the host (answers_load, answer_save). A change shows at once and is
// saved a moment later, so a dragged slider saves once. Saves go one at a
// time, each naming the revision it changed. When another window saved
// first, nothing is saved over it: its settings show, with a note saying so.
// Settings that couldn't be read are never written over.

import type { AnswerEntry, AnswerSaveResult, AnswersFile, AnswerStore, InputValues } from "./contract.ts";

/** How long a change waits for the next one before it is saved, in milliseconds. */
export const SAVE_DELAY_MS = 300;

/** The two host calls the store uses. Backend has both. */
export interface AnswerBackend {
  answersLoad(room: string): Promise<unknown>;
  answerSave(room: string, key: string, fingerprint: string, inputs: InputValues, revision: number): Promise<AnswerSaveResult>;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Read what answers_load returned. A damaged entry is left out; null reads as nothing saved. */
export function readAnswers(raw: unknown): AnswersFile {
  const cards: Record<string, AnswerEntry> = {};
  for (const [key, value] of Object.entries(record(record(raw).cards))) {
    const entry = record(value);
    if (typeof entry.fingerprint !== "string" || !Number.isInteger(entry.revision) || (entry.revision as number) < 1) continue;
    const inputs: InputValues = {};
    for (const [id, setting] of Object.entries(record(entry.inputs))) {
      if ((typeof setting === "number" && Number.isFinite(setting)) || typeof setting === "string") inputs[id] = setting;
    }
    cards[key] = { fingerprint: entry.fingerprint, inputs, revision: entry.revision as number, at: typeof entry.at === "number" ? entry.at : 0 };
  }
  return { version: 1, cards };
}

const CLASHED = "Another window changed this card, so your last change wasn't saved.";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Card {
  /** What the host has, as far as this window knows. */
  saved: AnswerEntry | null;
  /** What the card shows: the saved settings, or ones changed here. */
  shown: { fingerprint: string; inputs: InputValues } | null;
  dirty: boolean;
  status?: string;
  timer?: ReturnType<typeof setTimeout>;
}

const activeStores = new Set<AnswerStore>();
const pendingProblem = new WeakMap<AnswerStore, () => string | undefined>();
const discardSettings = new WeakMap<AnswerStore, (upto: number) => void>();
const owners = new WeakMap<AnswerStore, { backend: AnswerBackend; room: string }>();

/** Clear/rewind removes cached settings as well as their host files. */
export function discardAnswerSettingsAfter(store: AnswerStore | null, upto: number): void {
  if (store) discardSettings.get(store)?.(upto);
}

/** Keep a pane's store available to application lifecycle actions. */
export function retainAnswerStore(store: AnswerStore): () => void {
  activeStores.add(store);
  return () => { activeStores.delete(store); };
}

/** Forks wait for settings; quit uses the same flush before exiting. */
export async function flushAnswerStores(backend?: AnswerBackend, room?: string): Promise<void> {
  await Promise.all([...activeStores].filter(store => !backend || (owners.get(store)?.backend === backend && owners.get(store)?.room === room)).map(async (store) => {
    await store.flush();
    const problem = pendingProblem.get(store)?.();
    if (problem) throw new Error(problem);
  }));
}

export function createAnswerStore(backend: AnswerBackend, room: string, delay = SAVE_DELAY_MS): AnswerStore {
  const cards = new Map<string, Card>();
  const listeners = new Map<string, Set<() => void>>();
  let problem: string | undefined = "Saved settings are still loading, so changes here won't be kept yet.";
  let queue: Promise<void> = Promise.resolve();

  const card = (key: string): Card => {
    let one = cards.get(key);
    if (!one) cards.set(key, (one = { saved: null, shown: null, dirty: false }));
    return one;
  };
  const tell = (key: string) => listeners.get(key)?.forEach((listener) => listener());

  const save = async (key: string) => {
    const one = card(key);
    const mine = one.shown;
    if (!mine || !one.dirty || problem) return;
    let result: AnswerSaveResult;
    try {
      result = await backend.answerSave(room, key, mine.fingerprint, mine.inputs, one.saved?.revision ?? 0);
    } catch (error) {
      one.status = `Couldn't save: ${message(error)}`;
      tell(key);
      return;
    }
    if ("saved" in result) {
      one.saved = result.saved;
      one.status = undefined;
      if (one.shown === mine) { one.shown = null; one.dirty = false; }
    } else {
      // Another window saved first. Its settings show, rather than these being saved over them.
      one.saved = result.conflict;
      clearTimeout(one.timer);
      one.timer = undefined;
      one.shown = null;
      one.dirty = false;
      one.status = CLASHED;
    }
    tell(key);
  };

  const schedule = (key: string) => {
    const one = card(key);
    one.timer = undefined;
    queue = queue.then(() => save(key));
    return queue;
  };

  const store: AnswerStore = {
    async load() {
      const before = new Map([...cards].map(([key, one]) => [key, one.saved]));
      const unchanged = (key: string, one: Card) => !one.dirty && one.saved === (before.get(key) ?? null);
      try {
        const file = readAnswers(await backend.answersLoad(room));
        // A local unsaved edit keeps the revision it was based on. Retrying
        // after reconnect must still conflict if another window saved first.
        for (const [key, one] of cards) if (unchanged(key, one)) one.saved = file.cards[key] ?? null;
        for (const [key, entry] of Object.entries(file.cards)) {
          const one = card(key);
          if (unchanged(key, one)) one.saved = entry;
        }
        problem = undefined;
      } catch (error) {
        problem = /unknown variant [`'"]?answers_load|unknown command.*answers_load/i.test(message(error))
          ? "This machine's apex-daemon is too old to keep card settings."
          : "Saved settings couldn't be read, so changes here won't be kept.";
      }
      for (const key of listeners.keys()) tell(key);
    },
    values(key, print) {
      const one = cards.get(key);
      if (one?.shown?.fingerprint === print) return one.shown.inputs;
      if (one?.saved?.fingerprint === print) return one.saved.inputs;
      return null;
    },
    set(key, print, values) {
      const one = card(key);
      one.shown = { fingerprint: print, inputs: values };
      one.dirty = true;
      tell(key);
      if (problem) return;
      if (one.timer) clearTimeout(one.timer);
      one.timer = setTimeout(() => void schedule(key), delay);
    },
    status: (key) => problem ?? cards.get(key)?.status,
    subscribe(key, listener) {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(listener);
      return () => void set.delete(listener);
    },
    entries() {
      const out: Record<string, AnswerEntry> = {};
      for (const [key, one] of cards) {
        const shown = one.shown ?? one.saved;
        if (shown) out[key] = { fingerprint: shown.fingerprint, inputs: shown.inputs, revision: one.saved?.revision ?? 0, at: one.saved?.at ?? 0 };
      }
      return out;
    },
    flush() {
      for (const [key, one] of cards) {
        if (!one.dirty) continue;
        clearTimeout(one.timer);
        void schedule(key);
      }
      return queue;
    },
  };
  pendingProblem.set(store, () => [...cards.values()].some(one => one.dirty)
    ? problem ?? [...cards.values()].find(one => one.dirty)?.status ?? "Card settings haven't been saved yet."
    : undefined);
  discardSettings.set(store, (upto) => {
    for (const [key, one] of cards) {
      if (Number(key.split(':')[0]) < upto) continue;
      clearTimeout(one.timer);
      cards.delete(key);
      tell(key);
    }
  });
  owners.set(store, { backend, room });
  return store;
}
