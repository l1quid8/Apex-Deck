import { useCallback, useRef, useState } from "react";
import { addThreadLine, removeThread, restoreRemoved, threadIds } from "./sliceDraft";
import type { DraftDoc, RemovedSlice } from "./sliceDraft";

export interface MultiDraftState {
  on: boolean;
  doc: DraftDoc;
  tldr: boolean;
  overrides: Map<string, string>;
  draftId: string;
}

/** The ref is authoritative: Send can take a draft before React renders again. */
export function useMultiDraft() {
  const [state, render] = useState<MultiDraftState>(() => ({
    on: false, doc: [], tldr: false, overrides: new Map(), draftId: crypto.randomUUID(),
  }));
  const live = useRef(state);
  const [lastRemoved, showRemoved] = useState<RemovedSlice | null>(null);
  const removed = useRef<RemovedSlice | null>(null);
  const update = useCallback((next: MultiDraftState) => { live.current = next; render(next); }, []);
  const remember = useCallback((next: RemovedSlice | null) => { removed.current = next; showRemoved(next); }, []);
  const current = useCallback(() => live.current, []);
  const toggle = useCallback((paneId: string, hostId: string) => {
    const before = live.current;
    if (threadIds(before.doc).includes(paneId)) {
      const result = removeThread(before.doc, paneId);
      if (result.doc === before.doc) return; // ambiguous lines must be resolved first
      remember(result.removed);
      update({ ...before, on: threadIds(result.doc).length > 0, doc: result.doc });
    } else {
      remember(null);
      update({ ...before, on: true, doc: addThreadLine(before.doc, { paneId, hostId }).doc });
    }
  }, [update, remember]);
  const exit = useCallback(() => update({ ...live.current, on: false }), [update]);
  const open = useCallback(() => update({ ...live.current, on: true }), [update]);
  const setDoc = useCallback((doc: DraftDoc) => {
    remember(null);
    update({ ...live.current, doc });
  }, [update, remember]);
  const setTldr = useCallback((tldr: boolean) => update({ ...live.current, tldr }), [update]);
  const setOverride = useCallback((paneId: string, agentId: string | null) => {
    const overrides = new Map(live.current.overrides);
    if (agentId === null) overrides.delete(paneId); else overrides.set(paneId, agentId);
    update({ ...live.current, overrides });
  }, [update]);
  const undoRemove = useCallback(() => {
    if (!removed.current) return;
    update({ ...live.current, on: true, doc: restoreRemoved(live.current.doc, removed.current) });
    remember(null);
  }, [update, remember]);
  const take = useCallback(() => {
    const taken = live.current;
    update({ on: false, doc: [], tldr: taken.tldr, overrides: new Map(), draftId: crypto.randomUUID() });
    remember(null);
    return taken;
  }, [update, remember]);
  return { ...state, selected: state.on ? threadIds(state.doc) : [], lastRemoved,
    current, toggle, open, exit, setDoc, setTldr, setOverride, undoRemove, take };
}
