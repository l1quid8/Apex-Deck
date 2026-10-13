// Interactive answers: the names both halves of the feature share. The card
// itself (schema.ts, comparison.ts, share.ts, AnswerCard.tsx) and the
// settings people choose on it (answerStore.ts; the host's answers_load and
// answer_save) are built in parallel against this file, so change it only by
// agreement. Plan: docs/superpowers/plans/2026-10-12-interactive-answers-m1.md

/** A card is a fenced block in a bot's reply, written in this language. */
export const CARD_LANGUAGE = "apex-ui";

/** Settings a person chose on a card, by input id: a number for a range, an option id for a choice. */
export type InputValues = Record<string, number | string>;

/** Where a card's settings are kept in its thread: the reply's message number, then the card's id. */
export function cardKey(seq: number, cardId: string): string {
  return `${seq}:${cardId}`;
}

/**
 * A card source's fingerprint: FNV-1a over its UTF-16 code units, as 8
 * lowercase hex digits. Saved settings apply only to a card with the same
 * fingerprint, so a reply that later takes the same message number (after a
 * rewind, or in a fork) never picks up settings made on another card.
 */
export function fingerprint(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** One card's saved settings, as the host keeps them in rooms/<hex id>.answers.json. */
export interface AnswerEntry {
  fingerprint: string;
  inputs: InputValues;
  /** 1 for the first save, one more for each after it. */
  revision: number;
  /** When it was saved, in milliseconds since the epoch. The host sets it. */
  at: number;
}

/** What answers_load returns for a thread with saved settings. It returns null for one without. */
export interface AnswersFile {
  version: 1;
  /** By cardKey. */
  cards: Record<string, AnswerEntry>;
}

/**
 * What answer_save returns. A save names the revision its settings were
 * changed from, 0 when there was none. The host keeps it when that is still
 * the saved revision, or when nothing is saved under the key yet. Otherwise
 * nothing changes and the newer entry comes back as the conflict.
 */
export type AnswerSaveResult = { saved: AnswerEntry } | { conflict: AnswerEntry };

/** One thread's card settings, as a chat uses them. answerStore.ts makes it. */
export interface AnswerStore {
  /** Read the thread's saved settings. Never rejects: when they can't be read, each card says so and nothing is saved. */
  load(): Promise<void>;
  /** The settings to show on the card at `key`, when they were set on a source with this fingerprint; otherwise null. */
  values(key: string, fingerprint: string): InputValues | null;
  /** Show `values` at once and save them a moment later, so a dragged slider saves once. */
  set(key: string, fingerprint: string, values: InputValues): void;
  /** A short note for under the card's buttons, such as "Couldn't save: …"; undefined when all is well. */
  status(key: string): string | undefined;
  /** Hear about changes to the card at `key`. Returns the function that stops it. */
  subscribe(key: string, listener: () => void): () => void;
  /** What every card shows now, by cardKey, for exports. */
  entries(): Record<string, AnswerEntry>;
  /** Save anything still waiting. */
  flush(): Promise<void>;
}
