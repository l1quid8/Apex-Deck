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
  status?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export function createAnswerStore(backend: AnswerBackend, room: string, delay = SAVE_DELAY_MS): AnswerStore {
  const cards = new Map<string, Card>();
  const listeners = new Map<string, Set<() => void>>();
  let problem: string | undefined = "Saved settings are still loading, so changes here won't be kept yet.";
  let queue: Promise<void> = Promise.resolve();

  const card = (key: string): Card => {
    let one = cards.get(key);
    if (!one) cards.set(key, (one = { saved: null, shown: null }));
    return one;
  };
  const tell = (key: string) => listeners.get(key)?.forEach((listener) => listener());

  const save = async (key: string) => {
    const one = card(key);
    const mine = one.shown;
    if (!mine || problem) return;
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
    } else {
      // Another window saved first. Its settings show, rather than these being saved over them.
      one.saved = result.conflict;
      clearTimeout(one.timer);
      one.timer = undefined;
      one.shown = null;
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

  return {
    async load() {
      try {
        const file = readAnswers(await backend.answersLoad(room));
        for (const [key, entry] of Object.entries(file.cards)) card(key).saved = entry;
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
        if (!one.timer) continue;
        clearTimeout(one.timer);
        void schedule(key);
      }
      return queue;
    },
  };
}
