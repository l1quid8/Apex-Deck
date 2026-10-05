// What a docked pane shows when its page won't load. Main reports a failure
// with every state until the next load starts; the pane keeps showing it
// through that load too, so trying again every 2 s doesn't flash a blank page.

import type { BrowserState } from "./backend";

export type LoadError = NonNullable<BrowserState["error"]>;

/** The failure to show after `state`, given the one shown before it. */
export function loadFailure(previous: LoadError | null, state: BrowserState): LoadError | null {
  if (state.error) return state.error;
  return state.loading ? previous : null;
}
