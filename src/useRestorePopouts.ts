import { useEffect, useRef, useState } from "react";

export interface PopoutIdentity { kind: "pane" | "tab"; id: string }
interface Available { panes: string[]; tabs: string[] }

/** Rebuild each external view from the live session, after the previous takeout commits. */
export function useRestorePopouts(
  ready: boolean,
  saved: PopoutIdentity[] | null,
  available: Available,
  openPane: (id: string) => Promise<void> | void,
  openTab: (id: string) => Promise<void> | void,
  onError: (error: unknown) => void,
) {
  const [pending, setPending] = useState<PopoutIdentity[] | null>(null);
  const busy = useRef(false);
  // Each render supplies fresh layout closures. Restoring all windows in one
  // async loop would remove them from the same old tree and undo prior takeouts.
  useEffect(() => {
    if (!ready || !saved || busy.current || pending?.length === 0) return;
    if (pending === null) {
      setPending(saved);
      return;
    }
    busy.current = true;
    const next = pending[0];
    const exists = (next.kind === "pane" ? available.panes : available.tabs).includes(next.id);
    void Promise.resolve().then(() => {
      if (exists) return (next.kind === "pane" ? openPane : openTab)(next.id);
    }).catch(onError).finally(() => {
      busy.current = false;
      setPending(list => list?.slice(1) ?? []);
    });
  });
}
