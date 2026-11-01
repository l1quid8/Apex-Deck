// The Appearance draft, held by App because the bar outside Settings needs it
// too. Every action writes through setSettings, so leaving or closing Settings
// can't touch it. Only apply() changes what Deck paints.

import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";

import {
  appliedName, applyDraft, clearEdits, deckLabel, deletePreset, discardDraft, displayName, editedKeys, pendingChanges, renamePreset,
  revertPending, savePreset, storeDraft, updatePreset, workingDraft, type AppearanceDraft, type PendingChange, type PendingLabel,
} from "./appearanceDraft.ts";
import type { AppSettings } from "./settings.ts";

const APPEARANCE_KEYS = ["appearance", "appearanceDraft", "botChips", "landingTexture"] as const;

/** Put the appearance keys of an earlier moment back, leaving everything else as it is now. */
function restore(now: AppSettings, earlier: AppSettings): AppSettings {
  const next = { ...now };
  for (const key of APPEARANCE_KEYS) {
    if (earlier[key] === undefined) delete next[key];
    else Object.assign(next, { [key]: earlier[key] });
  }
  return next;
}

export interface AppearanceStudioState {
  draft: AppearanceDraft;
  pending: PendingChange[];
  edit(next: AppearanceDraft): void;
  apply(): void;
  discard(): void;
  revert(label: PendingLabel): void;
  clear(): void;
  save(name: string): void;
  update(): void;
  rename(from: string, to: string): void;
  remove(name: string): void;
  /** Add a preset that came from elsewhere. */
  change(update: (settings: AppSettings) => AppSettings): void;
}

export function useAppearanceDraft(settings: AppSettings, setSettings: Dispatch<SetStateAction<AppSettings>>, toast: (text: string, undo?: () => void) => void, systemDark: boolean): AppearanceStudioState {
  const draft = useMemo(() => workingDraft(settings), [settings]);
  const pending = useMemo(() => pendingChanges(settings, draft, systemDark), [settings, draft, systemDark]);
  const saved = settings.appearance?.saved ?? [];

  const undoTo = useCallback((earlier: AppSettings) => () => setSettings((now) => restore(now, earlier)), [setSettings]);

  return {
    draft,
    pending,
    edit: (next) => setSettings((now) => storeDraft(now, next)),
    apply: () => {
      if (!pending.length) return;
      const unsaved = editedKeys(draft, saved).length > 0;
      const next = applyDraft(storeDraft(settings, draft));
      setSettings((now) => applyDraft(now));
      toast(`Deck now uses ${deckLabel(next, systemDark)}.${unsaved ? " No preset was saved." : ""}`, undoTo(settings));
    },
    discard: () => {
      setSettings((now) => discardDraft(now));
      toast(`Draft discarded. Deck stays on ${deckLabel(settings, systemDark)}. Saved presets are kept.`, undoTo(settings));
    },
    revert: (label) => setSettings((now) => storeDraft(now, revertPending(now, workingDraft(now), label))),
    clear: () => {
      setSettings((now) => storeDraft(now, clearEdits(workingDraft(now), now.appearance?.saved ?? [])));
      toast(`Edits cleared. Back to ${displayName(draft.source)}.`, undoTo(settings));
    },
    save: (name) => {
      setSettings((now) => savePreset(now, name));
      toast(`${name.trim()} saved to your presets.`);
    },
    update: () => {
      const usedByDeck = appliedName(settings).startsWith(displayName(draft.source));
      setSettings((now) => updatePreset(now));
      toast(usedByDeck ? `${displayName(draft.source)} updated. Deck keeps the earlier version until you apply.` : `${displayName(draft.source)} updated.`);
    },
    rename: (from, to) => {
      setSettings((now) => renamePreset(now, from, to));
      toast(`Renamed to ${to.trim()}.`);
    },
    remove: (name) => {
      const inUse = draft.source.kind === "saved" && draft.source.name === name;
      setSettings((now) => deletePreset(now, name));
      toast(`${name} deleted.${inUse ? " Your settings are still here as unsaved changes." : ""}`, undoTo(settings));
    },
    change: (update) => setSettings(update),
  };
}
